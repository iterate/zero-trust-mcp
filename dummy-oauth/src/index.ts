/**
 * dummy-oauth-provider — a deliberately tiny fake OAuth 2.0 provider + API,
 * used as the "real third-party" for zero-trust-mcp's demo integration.
 *
 * Same stateless trick as the MCP server: codes and tokens are sealed
 * AES-GCM blobs, no storage. Any client_id is accepted (it's fake).
 *
 *   GET  /authorize?redirect_uri&state   → consent page (name + Approve)
 *   POST /authorize                      → 302 redirect_uri?code=...&state=...
 *   POST /token                          → authorization_code | refresh_token grants
 *   GET  /api/me                         → the "product": bearer-protected profile
 */

import { seal, unseal, nowSeconds } from "./seal.js";

interface Env {
  SEAL_KEY: string;
}

const ACCESS_TTL = 3600;

function consentPage(params: { redirect_uri: string; state: string; client_id: string }, origin: string): string {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${v.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" />`)
    .join("\n");
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dummy OAuth Provider</title>
<style>
 body{font-family:-apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#eef2ff}
 .card{background:#fff;border-radius:12px;box-shadow:0 2px 24px rgba(0,0,0,.08);padding:2.5rem;width:22rem}
 h1{font-size:1.1rem;margin:0 0 .5rem} p{color:#555;font-size:.85rem}
 label{display:block;font-size:.8rem;font-weight:600;margin:1rem 0 .3rem}
 input[type=text]{width:100%;box-sizing:border-box;padding:.6rem;border:1px solid #ccc;border-radius:8px}
 button{margin-top:1.5rem;width:100%;padding:.7rem;border:0;border-radius:8px;background:#4f46e5;color:#fff;font-weight:600;font-size:1rem;cursor:pointer}
</style></head>
<body><main class="card">
<h1>🎭 Dummy OAuth Provider</h1>
<p><b>${params.client_id || "an app"}</b> wants access to your (entirely fictional) account.</p>
<form method="post" action="/authorize">
${hidden}
<label for="name">Your name</label>
<input type="text" id="name" name="name" value="Demo User" />
<button type="submit">Approve</button>
</form>
</main></body></html>`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

async function issueTokens(sub: string, sealKey: string): Promise<Response> {
  return json({
    access_token: await seal({ t: "access", sub, exp: nowSeconds() + ACCESS_TTL }, sealKey),
    token_type: "bearer",
    expires_in: ACCESS_TTL,
    refresh_token: await seal({ t: "refresh", sub }, sealKey),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize") {
      if (request.method === "GET") {
        const redirect_uri = url.searchParams.get("redirect_uri") ?? "";
        if (!redirect_uri) return new Response("redirect_uri required", { status: 400 });
        return new Response(
          consentPage(
            {
              redirect_uri,
              state: url.searchParams.get("state") ?? "",
              client_id: url.searchParams.get("client_id") ?? "",
            },
            url.origin,
          ),
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }
      if (request.method === "POST") {
        const form = await request.formData();
        const redirectUri = String(form.get("redirect_uri") ?? "");
        if (!redirectUri) return new Response("redirect_uri required", { status: 400 });
        const sub = String(form.get("name") || "Demo User").slice(0, 64);
        const code = await seal({ t: "code", sub, exp: nowSeconds() + 120 }, env.SEAL_KEY);
        const target = new URL(redirectUri);
        target.searchParams.set("code", code);
        const state = String(form.get("state") ?? "");
        if (state) target.searchParams.set("state", state);
        return Response.redirect(target.toString(), 302);
      }
    }

    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      const grantType = form.get("grant_type");
      if (grantType === "authorization_code") {
        const code = await unseal<{ t: string; sub: string; exp: number }>(form.get("code") ?? "", env.SEAL_KEY);
        if (!code || code.t !== "code") return json({ error: "invalid_grant" }, 400);
        if (code.exp < nowSeconds()) return json({ error: "invalid_grant", error_description: "code expired" }, 400);
        return issueTokens(code.sub, env.SEAL_KEY);
      }
      if (grantType === "refresh_token") {
        const rt = await unseal<{ t: string; sub: string }>(form.get("refresh_token") ?? "", env.SEAL_KEY);
        if (!rt || rt.t !== "refresh") return json({ error: "invalid_grant" }, 400);
        return issueTokens(rt.sub, env.SEAL_KEY);
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }

    if (url.pathname === "/api/me" && request.method === "GET") {
      const header = request.headers.get("Authorization") ?? "";
      const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
      const at = await unseal<{ t: string; sub: string; exp: number }>(token, env.SEAL_KEY);
      if (!at || at.t !== "access" || at.exp < nowSeconds()) {
        return json({ error: "invalid_token" }, 401);
      }
      return json({
        sub: at.sub,
        plan: "gold",
        favorite_number: 42,
        issued_by: "dummy-oauth-provider",
        token_expires_in: at.exp - nowSeconds(),
      });
    }

    if (url.pathname === "/") {
      return new Response("dummy-oauth-provider: /authorize, /token, /api/me", {
        headers: { "Content-Type": "text/plain" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
};
