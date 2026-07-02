import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  CORS_HEADERS,
  authorizationServerMetadata,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleRegister,
  handleToken,
  handleUpstreamCallback,
  protectedResourceMetadata,
  unauthorized,
  verifyAccessToken,
} from "./oauth.js";
import { indexPage } from "./html.js";
import type { Env, Integration } from "./integrations/types.js";
import { waitrose } from "./integrations/waitrose/index.js";
import { demo } from "./integrations/demo/index.js";

// The whole "folder full of integrations" idea: one entry here, one folder
// under src/integrations/, and the worker serves it at /<id>/mcp with a
// complete standalone OAuth lifecycle.
const integrations: Record<string, Integration> = {
  [waitrose.id]: waitrose,
  [demo.id]: demo,
};

// One handler at module scope; the factory runs per request and registers
// the tool set of whichever integration the bearer token was sealed for.
const mcpHandler = createMcpHandler(({ authInfo }) => {
  const { integrationId, session } = authInfo!.extra as { integrationId: string; session: unknown };
  const server = new McpServer({ name: `zero-trust-mcp-${integrationId}`, version: "0.3.0" });
  integrations[integrationId].registerTools(server, session);
  return server;
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { origin, pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Discovery. The resource is /<id>/mcp and the issuer is /<id>, so per
    // RFC 9728 / RFC 8414 clients request:
    //   /.well-known/oauth-protected-resource/<id>/mcp
    //   /.well-known/oauth-authorization-server/<id>
    for (const [prefix, handler] of [
      ["/.well-known/oauth-protected-resource", protectedResourceMetadata],
      ["/.well-known/oauth-authorization-server", authorizationServerMetadata],
    ] as const) {
      if (pathname.startsWith(prefix)) {
        const id = pathname.slice(prefix.length).split("/").filter(Boolean)[0];
        if (id && integrations[id]) return handler(origin, id);
        return new Response("Unknown integration", { status: 404, headers: CORS_HEADERS });
      }
    }

    // /<integration>/<endpoint>
    const [, first, second] = pathname.split("/");
    const integration = integrations[first];
    if (integration) {
      if (second === "register" && request.method === "POST") return handleRegister(request, env.SEAL_KEY);
      if (second === "authorize" && request.method === "GET") return handleAuthorizeGet(request, integration, env);
      if (second === "authorize" && request.method === "POST") return handleAuthorizePost(request, integration, env);
      if (second === "callback" && request.method === "GET") return handleUpstreamCallback(request, integration, env);
      if (second === "token" && request.method === "POST") return handleToken(request, integration, env);

      if (second === "mcp") {
        const payload = await verifyAccessToken(request, integration.id, env.SEAL_KEY);
        if (!payload) return unauthorized(origin, integration.id);
        const response = await mcpHandler.fetch(request, {
          authInfo: {
            token: "sealed", // never re-expose the raw token to handlers
            clientId: "public",
            scopes: [],
            expiresAt: payload.exp,
            extra: { integrationId: integration.id, session: payload.s },
          },
        });
        const headers = new Headers(response.headers);
        for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
        return new Response(response.body, { status: response.status, headers });
      }
    }

    if (pathname === "/") {
      return new Response(indexPage(origin, Object.keys(integrations)), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
