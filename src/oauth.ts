/**
 * Fully stateless, scope-multiplexed OAuth 2.1 authorization server.
 *
 * Scopes ARE integrations: scope "waitrose demo" = a bundle with both.
 * Every artifact is a sealed AES-GCM blob — nothing is stored server-side:
 *
 * - client_id .... sealed registered redirect_uris
 * - /authorize ... multi-step wizard; progress rides in a sealed `wiz` blob
 *                  (hidden form field / OAuth state through upstream providers)
 * - cookie ....... sealed per-integration grants in the USER'S BROWSER, so a
 *                  re-authorization only asks for what it can't fast-pass
 * - code ......... sealed collected bundle + PKCE challenge
 * - access ....... sealed sessions per integration, exp = min across bundle
 * - refresh ...... sealed SNAPSHOT: grants + still-valid sessions, so a
 *                  refresh grant only re-contacts upstreams that expired
 */

import { seal, unseal, sha256b64url, nowSeconds } from "./seal.js";
import type { Env, Integration, PasswordIntegration } from "./integrations/types.js";
import { loginPage, type WizardStepInfo } from "./html.js";

const AUTH_CODE_TTL = 120;
const WIZARD_TTL = 600;
const EMPTY_BUNDLE_TTL = 3600;
const MAX_ACCESS_TTL = 3600;
const SESSION_REUSE_MARGIN = 90; // refresh a session if it expires within this many seconds
const COOKIE_NAME = "ztm_grants";
const COOKIE_TTL = 60 * 60 * 24 * 90;

// ---------------------------------------------------------------------------
// Sealed payload shapes
// ---------------------------------------------------------------------------

interface ClientPayload {
  t: "client";
  ru: string[];
}

/** Per-integration state bundled through code + refresh token. */
interface IntegrationState {
  grant: unknown;
  s: unknown; // session
  exp: number; // session expiry (epoch seconds)
  err?: string; // set when the last refresh attempt failed (degraded, not dead)
}

interface WizardPayload {
  t: "wiz";
  scopes: string[];
  collected: Record<string, IntegrationState>;
  ru: string; // client redirect_uri
  st: string; // client state
  cc: string; // PKCE challenge
  exp: number;
}

interface CodePayload {
  t: "code";
  scopes: string[];
  bundle: Record<string, IntegrationState>;
  cc: string;
  ru: string;
  exp: number;
}

export interface AccessPayload {
  t: "access";
  scopes: string[];
  integ: Record<string, { s: unknown; exp: number; err?: string }>;
  exp: number;
}

interface RefreshPayload {
  t: "refresh";
  scopes: string[];
  integ: Record<string, IntegrationState>;
}

interface CookiePayload {
  t: "cookie";
  g: Record<string, unknown>; // integration id → grant
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name",
  "Access-Control-Expose-Headers": "WWW-Authenticate",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...headers },
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function oauthError(error: string, description: string, status = 400): Response {
  return jsonResponse({ error, error_description: description }, status);
}

function redirectUriAllowed(candidate: string, registered: string[]): boolean {
  if (registered.includes(candidate)) return true;
  try {
    const c = new URL(candidate);
    if (c.hostname !== "localhost" && c.hostname !== "127.0.0.1") return false;
    // Loopback port may vary per RFC 8252 §7.3 (Claude Code binds a random port).
    return registered.some((r) => {
      try {
        const reg = new URL(r);
        return (
          (reg.hostname === "localhost" || reg.hostname === "127.0.0.1") &&
          reg.protocol === c.protocol &&
          reg.pathname === c.pathname
        );
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

async function readGrantCookie(request: Request, sealKey: string): Promise<Record<string, unknown>> {
  const header = request.headers.get("Cookie") ?? "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return {};
  const payload = await unseal<CookiePayload>(match[1], sealKey);
  return payload?.t === "cookie" ? payload.g : {};
}

async function grantCookieHeader(grants: Record<string, unknown>, sealKey: string): Promise<string> {
  const sealed = await seal({ t: "cookie", g: grants } satisfies CookiePayload, sealKey);
  return `${COOKIE_NAME}=${sealed}; Path=/; Max-Age=${COOKIE_TTL}; HttpOnly; Secure; SameSite=Lax`;
}

// ---------------------------------------------------------------------------
// Discovery metadata (scopes deliberately NOT advertised: fresh connections
// start with an empty bundle and grow via 403 insufficient_scope step-up)
// ---------------------------------------------------------------------------

export function protectedResourceMetadata(origin: string): Response {
  return jsonResponse({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    resource_name: "zero-trust-mcp",
  });
}

export function authorizationServerMetadata(origin: string): Response {
  return jsonResponse({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

// ---------------------------------------------------------------------------
// Dynamic client registration
// ---------------------------------------------------------------------------

export async function handleRegister(request: Request, sealKey: string): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return oauthError("invalid_client_metadata", "Body must be JSON");
  }
  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every((u) => typeof u === "string")) {
    return oauthError("invalid_redirect_uri", "redirect_uris (non-empty string array) is required");
  }
  const clientId = await seal({ t: "client", ru: redirectUris } satisfies ClientPayload, sealKey);
  return jsonResponse(
    {
      client_id: clientId,
      client_name: typeof body.client_name === "string" ? body.client_name : undefined,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
  );
}

// ---------------------------------------------------------------------------
// /authorize — the multi-step wizard
// ---------------------------------------------------------------------------

export async function handleAuthorizeGet(
  request: Request,
  integrations: Record<string, Integration>,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const params = url.searchParams;

  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  if ((params.get("response_type") ?? "code") !== "code") {
    return oauthError("unsupported_response_type", "Only response_type=code is supported");
  }
  if (!codeChallenge || (params.get("code_challenge_method") ?? "S256") !== "S256") {
    return oauthError("invalid_request", "PKCE with S256 code_challenge is required");
  }
  const client = await unseal<ClientPayload>(clientId, env.SEAL_KEY);
  if (!client || client.t !== "client") {
    return oauthError("invalid_client", "Unknown client_id — register first at /register", 401);
  }
  if (!redirectUriAllowed(redirectUri, client.ru)) {
    return oauthError("invalid_request", "redirect_uri does not match any registered redirect URI");
  }

  const scopes = (params.get("scope") ?? "")
    .split(/[\s+]+/)
    .filter((s) => s in integrations);

  const wiz: WizardPayload = {
    t: "wiz",
    scopes,
    collected: {},
    ru: redirectUri,
    st: params.get("state") ?? "",
    cc: codeChallenge,
    exp: nowSeconds() + WIZARD_TTL,
  };
  return advanceWizard(wiz, request, integrations, env, url.origin);
}

/**
 * Drive the wizard forward: fast-pass every remaining integration whose grant
 * is in the browser cookie, stop at the first one that needs the user
 * (password form or upstream redirect), finish with code + Set-Cookie.
 */
async function advanceWizard(
  wiz: WizardPayload,
  request: Request,
  integrations: Record<string, Integration>,
  env: Env,
  origin: string,
): Promise<Response> {
  if (wiz.exp < nowSeconds()) return oauthError("invalid_request", "Authorization session expired — restart the flow");
  const cookieGrants = await readGrantCookie(request, env.SEAL_KEY);

  for (const id of wiz.scopes) {
    if (wiz.collected[id]) continue;
    const integration = integrations[id];

    if (cookieGrants[id] !== undefined) {
      try {
        const r = await integration.refreshGrant(cookieGrants[id], env);
        wiz.collected[id] = { grant: r.grant, s: r.session, exp: nowSeconds() + r.expiresInSeconds };
        continue; // fast-passed, no user interaction
      } catch {
        // stale cookie grant — fall through to the interactive step
      }
    }

    const sealedWiz = await seal(wiz, env.SEAL_KEY);
    const step: WizardStepInfo = {
      position: Object.keys(wiz.collected).length + 1,
      total: wiz.scopes.length,
    };
    if (integration.kind === "password") {
      return htmlResponse(loginPage(integration, sealedWiz, step));
    }
    // OAuth integration: bounce out to the provider, wizard state rides in `state`.
    return Response.redirect(integration.authorizeUrl(`${origin}/callback/${id}`, sealedWiz, env), 302);
  }

  // All requested integrations collected (possibly zero) — mint the code.
  const code = await seal(
    { t: "code", scopes: wiz.scopes, bundle: wiz.collected, cc: wiz.cc, ru: wiz.ru, exp: nowSeconds() + AUTH_CODE_TTL } satisfies CodePayload,
    env.SEAL_KEY,
  );
  const redirect = new URL(wiz.ru);
  redirect.searchParams.set("code", code);
  if (wiz.st) redirect.searchParams.set("state", wiz.st);

  const headers = new Headers({ Location: redirect.toString() });
  if (Object.keys(wiz.collected).length > 0) {
    const merged = { ...cookieGrants };
    for (const [id, state] of Object.entries(wiz.collected)) merged[id] = state.grant;
    headers.set("Set-Cookie", await grantCookieHeader(merged, env.SEAL_KEY));
  }
  return new Response(null, { status: 302, headers });
}

/** POST /authorize — a password integration's login form submission. */
export async function handleAuthorizePost(
  request: Request,
  integrations: Record<string, Integration>,
  env: Env,
): Promise<Response> {
  const form = await request.formData();
  const wiz = await unseal<WizardPayload>(String(form.get("wiz") ?? ""), env.SEAL_KEY);
  if (!wiz || wiz.t !== "wiz") return oauthError("invalid_request", "Invalid or expired authorization session");
  if (wiz.exp < nowSeconds()) return oauthError("invalid_request", "Authorization session expired — restart the flow");

  const id = String(form.get("integration") ?? "");
  const integration = integrations[id];
  if (!integration || integration.kind !== "password" || !wiz.scopes.includes(id) || wiz.collected[id]) {
    return oauthError("invalid_request", "Unexpected wizard step");
  }

  const sealedWiz = await seal(wiz, env.SEAL_KEY);
  const step: WizardStepInfo = { position: Object.keys(wiz.collected).length + 1, total: wiz.scopes.length };

  const creds: Record<string, string> = {};
  for (const field of (integration as PasswordIntegration).fields) {
    const value = form.get(field.name);
    if (typeof value !== "string" || !value) {
      return htmlResponse(loginPage(integration, sealedWiz, step, `Please fill in ${field.label}`), 400);
    }
    creds[field.name] = value;
  }

  try {
    const r = await (integration as PasswordIntegration).login(creds, env);
    wiz.collected[id] = { grant: r.grant, s: r.session, exp: nowSeconds() + r.expiresInSeconds };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Login failed";
    return htmlResponse(loginPage(integration, sealedWiz, step, message), 401);
  }
  return advanceWizard(wiz, request, integrations, env, new URL(request.url).origin);
}

/** GET /callback/<id> — an OAuth integration's provider sent the user back. */
export async function handleUpstreamCallback(
  request: Request,
  integrationId: string,
  integrations: Record<string, Integration>,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const wiz = await unseal<WizardPayload>(url.searchParams.get("state") ?? "", env.SEAL_KEY);
  if (!wiz || wiz.t !== "wiz") return oauthError("invalid_request", "Invalid or expired authorization session");

  const integration = integrations[integrationId];
  if (!integration || integration.kind !== "oauth" || !wiz.scopes.includes(integrationId) || wiz.collected[integrationId]) {
    return oauthError("invalid_request", "Unexpected wizard step");
  }
  const code = url.searchParams.get("code");
  if (!code) return oauthError("access_denied", `${integration.name} did not return a code`);

  try {
    const r = await integration.exchangeCode(code, `${url.origin}/callback/${integrationId}`, env);
    wiz.collected[integrationId] = { grant: r.grant, s: r.session, exp: nowSeconds() + r.expiresInSeconds };
  } catch (error) {
    return oauthError("invalid_request", `Upstream exchange failed: ${error instanceof Error ? error.message : error}`);
  }
  return advanceWizard(wiz, request, integrations, env, url.origin);
}

// ---------------------------------------------------------------------------
// /token
// ---------------------------------------------------------------------------

export async function handleToken(
  request: Request,
  integrations: Record<string, Integration>,
  env: Env,
): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const grantType = form.get("grant_type");

  if (grantType === "authorization_code") {
    const code = await unseal<CodePayload>(form.get("code") ?? "", env.SEAL_KEY);
    if (!code || code.t !== "code") return oauthError("invalid_grant", "Invalid authorization code");
    if (code.exp < nowSeconds()) return oauthError("invalid_grant", "Authorization code expired");

    const verifier = form.get("code_verifier") ?? "";
    if (!verifier || (await sha256b64url(verifier)) !== code.cc) {
      return oauthError("invalid_grant", "PKCE verification failed");
    }
    const redirectUri = form.get("redirect_uri");
    if (redirectUri && redirectUri !== code.ru) {
      return oauthError("invalid_grant", "redirect_uri does not match authorization request");
    }
    return issueTokens(code.scopes, code.bundle, env.SEAL_KEY);
  }

  if (grantType === "refresh_token") {
    const refresh = await unseal<RefreshPayload>(form.get("refresh_token") ?? "", env.SEAL_KEY);
    if (!refresh || refresh.t !== "refresh") return oauthError("invalid_grant", "Invalid refresh token");

    // Snapshot refresh: only re-contact upstreams whose session is (nearly)
    // expired; carry still-valid sessions forward. A single failing upstream
    // degrades that integration (err flag) instead of killing the bundle.
    const bundle: Record<string, IntegrationState> = {};
    const now = nowSeconds();
    for (const id of refresh.scopes) {
      const entry = refresh.integ[id];
      const integration = integrations[id];
      if (!entry || !integration) continue;
      if (!entry.err && entry.exp - now > SESSION_REUSE_MARGIN) {
        bundle[id] = entry;
        continue;
      }
      try {
        const r = await integration.refreshGrant(entry.grant, env);
        bundle[id] = { grant: r.grant, s: r.session, exp: now + r.expiresInSeconds };
      } catch (error) {
        bundle[id] = {
          grant: entry.grant,
          s: null,
          exp: now + 300, // retry on a later refresh; keeps the grant material
          err: error instanceof Error ? error.message : "upstream refresh failed",
        };
      }
    }
    return issueTokens(refresh.scopes, bundle, env.SEAL_KEY);
  }

  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
}

async function issueTokens(
  scopes: string[],
  bundle: Record<string, IntegrationState>,
  sealKey: string,
): Promise<Response> {
  const now = nowSeconds();
  const entries = Object.values(bundle);
  const minExp = entries.length
    ? Math.min(...entries.map((e) => e.exp), now + MAX_ACCESS_TTL)
    : now + EMPTY_BUNDLE_TTL;

  const integ: AccessPayload["integ"] = {};
  for (const [id, e] of Object.entries(bundle)) integ[id] = { s: e.s, exp: e.exp, err: e.err };

  const accessToken = await seal({ t: "access", scopes, integ, exp: minExp } satisfies AccessPayload, sealKey);
  const refreshToken = await seal({ t: "refresh", scopes, integ: bundle } satisfies RefreshPayload, sealKey);
  return jsonResponse(
    {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: Math.max(minExp - now, 60),
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    },
    200,
    { "Cache-Control": "no-store" }, // RFC 6749 §5.1
  );
}

// ---------------------------------------------------------------------------
// Bearer verification + step-up for /mcp
// ---------------------------------------------------------------------------

export async function verifyAccessToken(request: Request, sealKey: string): Promise<AccessPayload | null> {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  const payload = await unseal<AccessPayload>(header.slice(7).trim(), sealKey);
  if (!payload || payload.t !== "access" || payload.exp < nowSeconds()) return null;
  return payload;
}

/** RFC 6750 bearer challenge: 401 invalid_token or 403 insufficient_scope. */
function bearerChallenge(origin: string, status: 401 | 403, error: string, description: string, scope?: string): Response {
  const attrs = [
    `error="${error}"`,
    `error_description="${description}"`,
    ...(scope !== undefined ? [`scope="${scope}"`] : []),
    `resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
  ];
  return jsonResponse({ error, error_description: description, ...(scope !== undefined && { scope }) }, status, {
    "WWW-Authenticate": `Bearer ${attrs.join(", ")}`,
  });
}

export function unauthorized(origin: string, description = "Missing or invalid access token"): Response {
  return bearerChallenge(origin, 401, "invalid_token", description);
}

/**
 * SEP-2350 scope step-up: tell the client the granted scope is insufficient
 * and which scope set to re-authorize with. Compliant clients re-run the
 * authorization flow (where the sealed cookie fast-passes everything already
 * connected) and retry the request with the new token.
 */
export function insufficientScope(origin: string, scopes: string[], description: string): Response {
  return bearerChallenge(origin, 403, "insufficient_scope", description, scopes.join(" "));
}
