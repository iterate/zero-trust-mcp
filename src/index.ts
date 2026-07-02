import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  CORS_HEADERS,
  authorizationServerMetadata,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleRegister,
  handleToken,
  handleUpstreamCallback,
  insufficientScope,
  protectedResourceMetadata,
  unauthorized,
  verifyAccessToken,
  type AccessPayload,
} from "./oauth.js";
import { indexPage } from "./html.js";
import type { Env, Integration } from "./integrations/types.js";
import { waitrose } from "./integrations/waitrose/index.js";
import { demo } from "./integrations/demo/index.js";

const integrations: Record<string, Integration> = {
  [waitrose.id]: waitrose,
  [demo.id]: demo,
};
const integrationIds = Object.keys(integrations);
const integrationEnum = z.enum(integrationIds as [string, ...string[]]);

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

// One handler at module scope; the factory runs per request and builds the
// tool surface from the scopes/sessions unsealed from that request's token.
const mcpHandler = createMcpHandler(({ authInfo }) => {
  const server = new McpServer({ name: "zero-trust-mcp", version: "0.2.0" });
  const { scopes, integ } = (authInfo?.extra ?? { scopes: [], integ: {} }) as {
    scopes: string[];
    integ: AccessPayload["integ"];
  };

  // Always present: the meta-tool that grows the bundle. Calling it for an
  // unconnected integration never reaches this handler — the HTTP layer
  // answers 403 insufficient_scope and the client re-authorizes. By the time
  // the (retried) call lands here, the scope is already granted.
  server.registerTool(
    "connect_integration",
    {
      description:
        `Connect a new integration to this MCP server (available: ${integrationIds.join(", ")}). ` +
        "Calling this triggers an authorization step the user must approve; afterwards the integration's tools become available.",
      inputSchema: z.object({ integration: integrationEnum }),
    },
    async ({ integration }) =>
      scopes.includes(integration)
        ? text(`✓ ${integrations[integration].name} is connected. Its tools (${integration}_*) are available — you may need to refresh the tool list.`)
        : text(`${integration} is not connected yet — call this tool again to trigger authorization.`),
  );

  if (scopes.length === 0) return server; // fresh bundle: connect_integration is the ONLY tool

  for (const id of scopes) {
    const state = integ[id];
    if (!state || state.err || state.s == null) continue; // degraded: visible via list_integrations
    integrations[id]?.registerTools(server, state.s);
  }

  server.registerTool(
    "list_integrations",
    { description: "List connected and available integrations, their health and session expiry." },
    async () => {
      const now = Math.floor(Date.now() / 1000);
      const report = integrationIds.map((id) => {
        if (!scopes.includes(id)) return { id, name: integrations[id].name, connected: false };
        const state = integ[id];
        return {
          id,
          name: integrations[id].name,
          connected: true,
          status: state?.err ? `error: ${state.err} (re-connect or wait for retry)` : "ok",
          sessionExpiresInSeconds: state ? Math.max(0, state.exp - now) : 0,
        };
      });
      return text(JSON.stringify(report, null, 2));
    },
  );

  server.registerTool(
    "disconnect_integration",
    {
      description: "Disconnect an integration from this MCP server. Triggers a re-authorization that drops it from the grant.",
      inputSchema: z.object({ integration: integrationEnum }),
    },
    async ({ integration }) =>
      scopes.includes(integration)
        ? text(`${integration} is still connected — call this tool again to trigger the disconnect re-authorization.`)
        : text(`✓ ${integrations[integration]?.name ?? integration} is disconnected.`),
  );

  return server;
});

/**
 * Scope step-up interception: decide, from the JSON-RPC body, whether this
 * tools/call needs scopes the token doesn't have. If so, answer 403
 * insufficient_scope (SEP-2350) instead of invoking the SDK — the client
 * re-authorizes with the advertised scope set and retries.
 */
function requiredScopeChange(rpc: any, payload: AccessPayload): { scopes: string[]; reason: string } | null {
  if (rpc?.method !== "tools/call") return null;
  const name: string = rpc?.params?.name ?? "";
  const target: string | undefined = rpc?.params?.arguments?.integration;

  if (name === "connect_integration" && target && target in integrations && !payload.scopes.includes(target)) {
    return { scopes: [...payload.scopes, target], reason: `Authorization required to connect ${target}` };
  }
  if (name === "disconnect_integration" && target && payload.scopes.includes(target)) {
    return { scopes: payload.scopes.filter((s) => s !== target), reason: `Re-authorization required to disconnect ${target}` };
  }
  // Defense in depth: a tool belonging to an unconnected integration.
  const owner = integrationIds.find((id) => name.startsWith(`${id}_`));
  if (owner && !payload.scopes.includes(owner)) {
    return { scopes: [...payload.scopes, owner], reason: `Authorization required to use ${owner} tools` };
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { origin, pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return protectedResourceMetadata(origin);
    }
    if (pathname.startsWith("/.well-known/oauth-authorization-server")) {
      return authorizationServerMetadata(origin);
    }

    if (pathname === "/register" && request.method === "POST") {
      return handleRegister(request, env.SEAL_KEY);
    }

    if (pathname === "/authorize") {
      if (request.method === "GET") return handleAuthorizeGet(request, integrations, env);
      if (request.method === "POST") return handleAuthorizePost(request, integrations, env);
    }

    const callbackMatch = pathname.match(/^\/callback\/([a-z0-9-]+)$/);
    if (callbackMatch && request.method === "GET") {
      return handleUpstreamCallback(request, callbackMatch[1], integrations, env);
    }

    if (pathname === "/token" && request.method === "POST") {
      return handleToken(request, integrations, env);
    }

    if (pathname === "/mcp") {
      const payload = await verifyAccessToken(request, env.SEAL_KEY);
      if (!payload) return unauthorized(origin);

      let forward = request;
      if (request.method === "POST") {
        const raw = await request.text();
        try {
          const rpc = JSON.parse(raw);
          const change = requiredScopeChange(rpc, payload);
          if (change) return insufficientScope(origin, change.scopes, change.reason);
        } catch {
          // not JSON — let the SDK produce the proper protocol error
        }
        forward = new Request(request.url, { method: "POST", headers: request.headers, body: raw });
      }

      const response = await mcpHandler.fetch(forward, {
        authInfo: {
          token: "sealed", // never re-expose the raw token to handlers
          clientId: "public",
          scopes: payload.scopes,
          expiresAt: payload.exp,
          extra: { scopes: payload.scopes, integ: payload.integ },
        },
      });
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
      return new Response(response.body, { status: response.status, headers });
    }

    if (pathname === "/") {
      return new Response(indexPage(origin, integrationIds), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
