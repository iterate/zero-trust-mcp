/**
 * A fully stateless OAuth 2.1 authorization server, instantiated once per
 * integration path (/waitrose/*, /monzo/*). Each integration is its own
 * little AS + resource-server pair; a token minted for one path is invalid
 * on every other (the integration id is sealed into the token).
 *
 * Nothing is stored server-side. Every artifact is a sealed AES-GCM blob:
 *
 * - client_id ...... the registered redirect_uris
 * - authorize state  the validated OAuth params, riding through the login
 *                    form (hidden field) or the upstream provider (`state`)
 * - code ........... upstream session + grant + PKCE challenge
 * - access token ... the upstream session (what a request needs)
 * - refresh token .. the durable grant (what can mint new sessions):
 *                    credentials for password integrations, the upstream
 *                    refresh token for OAuth ones
 *
 * Lifecycle: access token expires at the upstream's pace → the MCP client
 * runs a refresh grant → we re-establish the upstream session from the
 * sealed grant. If THAT fails (revoked upstream, changed password), the
 * grant is dead: we answer invalid_grant and the client re-runs the
 * interactive flow. That ladder is standard OAuth — no client cooperation
 * beyond spec compliance is required.
 */

import { seal, unseal, sha256b64url, nowSeconds } from "./seal.js";
import type {
  Env,
  GrantResult,
  Integration,
  PasswordIntegration,
  UserClientOAuthIntegration,
} from "./integrations/types.js";
import { connectionPage, loginPage } from "./html.js";

const AUTH_CODE_TTL = 120;
const AUTHORIZE_STATE_TTL = 600;
const CONNECTION_HANDOFF_TTL = 600;
const MAX_ACCESS_TTL = 3600;

// ---------------------------------------------------------------------------
// Sealed payload shapes
// ---------------------------------------------------------------------------

interface ClientPayload {
  t: "client";
  ru: string[];
}

/** The validated /authorize request, in flight through form or provider. */
interface StatePayload {
  t: "state";
  i: string; // integration id
  ru: string; // client redirect_uri
  st: string; // client state
  cc: string; // PKCE challenge (S256)
  /** User-supplied upstream OAuth client, present only after the setup POST. */
  uc?: Record<string, string>;
  exp: number;
}

interface CodePayload {
  t: "code";
  i: string;
  s: unknown; // upstream session
  se: number; // session expiry (epoch seconds)
  grant: unknown;
  cc: string;
  ru: string;
  exp: number;
}

export interface AccessPayload {
  t: "access";
  i: string;
  s: unknown;
  exp: number;
}

interface RefreshPayload {
  t: "refresh";
  i: string;
  grant: unknown;
}

/** Provider result held only by the browser while an extra approval completes. */
interface HandoffPayload {
  t: "handoff";
  i: string;
  state: StatePayload;
  result: GrantResult;
  exp: number;
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
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      // Chrome applies form-action to redirects as well as the initial POST.
      // OAuth setup posts to us, then redirects to an HTTPS provider; password
      // flows may redirect directly to a loopback MCP-client callback.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; base-uri 'none'",
    },
  });
}

function oauthError(error: string, description: string, status = 400): Response {
  return jsonResponse({ error, error_description: description }, status, { "Cache-Control": "no-store" });
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

// ---------------------------------------------------------------------------
// Discovery metadata — one resource + one issuer per integration path.
// The issuer is https://host/<id>, so RFC 8414 puts its metadata at
// /.well-known/oauth-authorization-server/<id> (path insertion).
// ---------------------------------------------------------------------------

export function protectedResourceMetadata(origin: string, id: string): Response {
  return jsonResponse({
    resource: `${origin}/${id}/mcp`,
    authorization_servers: [`${origin}/${id}`],
    bearer_methods_supported: ["header"],
    resource_name: `zero-trust-mcp: ${id}`,
  });
}

export function authorizationServerMetadata(origin: string, id: string): Response {
  return jsonResponse({
    issuer: `${origin}/${id}`,
    authorization_endpoint: `${origin}/${id}/authorize`,
    token_endpoint: `${origin}/${id}/token`,
    registration_endpoint: `${origin}/${id}/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591) — the registered redirect_uris are
// sealed INTO the client_id itself.
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
// /<id>/authorize
// ---------------------------------------------------------------------------

export async function handleAuthorizeGet(request: Request, integration: Integration, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const params = url.searchParams;

  if ((params.get("response_type") ?? "code") !== "code") {
    return oauthError("unsupported_response_type", "Only response_type=code is supported");
  }
  const codeChallenge = params.get("code_challenge") ?? "";
  if (!codeChallenge || (params.get("code_challenge_method") ?? "S256") !== "S256") {
    return oauthError("invalid_request", "PKCE with S256 code_challenge is required");
  }
  const client = await unseal<ClientPayload>(params.get("client_id") ?? "", env.SEAL_KEY);
  if (!client || client.t !== "client") {
    return oauthError("invalid_client", "Unknown client_id — register first", 401);
  }
  const redirectUri = params.get("redirect_uri") ?? "";
  if (!redirectUriAllowed(redirectUri, client.ru)) {
    return oauthError("invalid_request", "redirect_uri does not match any registered redirect URI");
  }

  const state = await seal(
    {
      t: "state",
      i: integration.id,
      ru: redirectUri,
      st: params.get("state") ?? "",
      cc: codeChallenge,
      exp: nowSeconds() + AUTHORIZE_STATE_TTL,
    } satisfies StatePayload,
    env.SEAL_KEY,
  );

  if (integration.kind === "password" || integration.kind === "user-client-oauth") {
    return htmlResponse(loginPage(integration, state));
  }
  // OAuth integration: hand off to the upstream provider; our sealed state
  // rides through its `state` parameter.
  return Response.redirect(integration.authorizeUrl(`${new URL(request.url).origin}/${integration.id}/callback`, state, env), 302);
}

async function unsealState(raw: string, integration: Integration, sealKey: string): Promise<StatePayload | null> {
  const state = await unseal<StatePayload>(raw, sealKey);
  if (!state || state.t !== "state" || state.i !== integration.id || state.exp < nowSeconds()) return null;
  return state;
}

/** Build the MCP client's callback URL with a freshly sealed authorization code. */
async function authorizationRedirectUrl(
  state: StatePayload,
  result: { session: unknown; expiresInSeconds: number; grant: unknown },
  sealKey: string,
): Promise<string> {
  const code = await seal(
    {
      t: "code",
      i: state.i,
      s: result.session,
      se: nowSeconds() + result.expiresInSeconds,
      grant: result.grant,
      cc: state.cc,
      ru: state.ru,
      exp: nowSeconds() + AUTH_CODE_TTL,
    } satisfies CodePayload,
    sealKey,
  );
  const redirect = new URL(state.ru);
  redirect.searchParams.set("code", code);
  if (state.st) redirect.searchParams.set("state", state.st);
  return redirect.toString();
}

/** Redirect back to the MCP client with a sealed authorization code. */
async function finishAuthorize(
  state: StatePayload,
  result: GrantResult,
  sealKey: string,
): Promise<Response> {
  return Response.redirect(await authorizationRedirectUrl(state, result, sealKey), 302);
}

/**
 * Providers with an extra approval step opt into the shared handoff page.
 * The credential-bearing result remains only in a sealed browser field.
 */
async function beginClientHandoff(
  integration: Integration,
  state: StatePayload,
  result: GrantResult,
  env: Env,
): Promise<Response> {
  if (!integration.connectionFlow) return finishAuthorize(state, result, env.SEAL_KEY);
  const browserState = { ...state, uc: undefined };
  const handoff = await seal(
    {
      t: "handoff",
      i: integration.id,
      state: browserState,
      result,
      exp: nowSeconds() + CONNECTION_HANDOFF_TTL,
    } satisfies HandoffPayload,
    env.SEAL_KEY,
  );
  return htmlResponse(connectionPage(integration, { phase: "instruction", handoff }));
}

/** POST /<id>/authorize — password login form submission. */
export async function handleAuthorizePost(request: Request, integration: Integration, env: Env): Promise<Response> {
  if (integration.kind === "oauth") return oauthError("invalid_request", "Unexpected form submission");
  const form = await request.formData();
  const state = await unsealState(String(form.get("state") ?? ""), integration, env.SEAL_KEY);
  if (!state) return oauthError("invalid_request", "Invalid or expired authorization session — restart the flow");
  const sealedState = String(form.get("state"));

  const creds: Record<string, string> = {};
  for (const field of integration.fields) {
    const value = form.get(field.name);
    if (typeof value !== "string" || !value) {
      return htmlResponse(loginPage(integration, sealedState, `Please fill in ${field.label}`), 400);
    }
    creds[field.name] = value;
  }

  if (integration.kind === "user-client-oauth") {
    const continuedState = await seal({ ...state, uc: creds } satisfies StatePayload, env.SEAL_KEY);
    const callbackUrl = `${new URL(request.url).origin}/${integration.id}/callback`;
    return Response.redirect(integration.authorizeUrl(callbackUrl, continuedState, creds, env), 302);
  }

  try {
    // A REAL upstream login happens here — bad credentials never mint a code.
    const result = await (integration as PasswordIntegration).login(creds, env);
    return beginClientHandoff(integration, state, result, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Login failed";
    return htmlResponse(loginPage(integration, sealedState, message), 401);
  }
}

/** GET /<id>/callback — the upstream OAuth provider sent the user back. */
export async function handleUpstreamCallback(request: Request, integration: Integration, env: Env): Promise<Response> {
  if (integration.kind === "password") return oauthError("invalid_request", "Integration has no upstream callback");
  const url = new URL(request.url);
  const state = await unsealState(url.searchParams.get("state") ?? "", integration, env.SEAL_KEY);
  if (!state) return oauthError("invalid_request", "Invalid or expired authorization session — restart the flow");
  const code = url.searchParams.get("code");
  if (!code) return oauthError("access_denied", `${integration.name} did not return a code`);

  try {
    const callbackUrl = `${url.origin}/${integration.id}/callback`;
    const result =
      integration.kind === "user-client-oauth"
        ? await integration.exchangeCode(code, callbackUrl, state.uc ?? {}, env)
        : await integration.exchangeCode(code, callbackUrl, env);
    return beginClientHandoff(integration, state, result, env);
  } catch (error) {
    return oauthError("invalid_request", `Upstream exchange failed: ${error instanceof Error ? error.message : error}`);
  }
}

/** POST /<id>/complete — generic provider-declared post-authorization check. */
export async function handleComplete(request: Request, integration: Integration, env: Env): Promise<Response> {
  const flow = integration.connectionFlow;
  if (!flow) return oauthError("invalid_request", `${integration.name} has no completion flow`);
  const form = await request.formData();
  const rawHandoff = String(form.get("handoff") ?? "");
  const handoff = await unseal<HandoffPayload>(rawHandoff, env.SEAL_KEY);
  if (!handoff || handoff.t !== "handoff" || handoff.i !== integration.id || handoff.exp < nowSeconds()) {
    return oauthError("invalid_request", "Invalid or expired connection handoff — restart the flow");
  }

  try {
    const readiness = await flow.check(handoff.result.session, env);
    if (readiness === "pending") {
      return htmlResponse(connectionPage(integration, { phase: "pending", handoff: rawHandoff }));
    }
    const returnUrl = await authorizationRedirectUrl(handoff.state, handoff.result, env.SEAL_KEY);
    return htmlResponse(connectionPage(integration, { phase: "ready", returnUrl }));
  } catch (error) {
    return oauthError(
      "temporarily_unavailable",
      `Could not verify ${integration.name} access: ${error instanceof Error ? error.message : error}`,
      502,
    );
  }
}

// ---------------------------------------------------------------------------
// /<id>/token
// ---------------------------------------------------------------------------

export async function handleToken(request: Request, integration: Integration, env: Env): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const grantType = form.get("grant_type");

  if (grantType === "authorization_code") {
    const code = await unseal<CodePayload>(form.get("code") ?? "", env.SEAL_KEY);
    if (!code || code.t !== "code" || code.i !== integration.id) {
      return oauthError("invalid_grant", "Invalid authorization code");
    }
    if (code.exp < nowSeconds()) return oauthError("invalid_grant", "Authorization code expired");

    const verifier = form.get("code_verifier") ?? "";
    if (!verifier || (await sha256b64url(verifier)) !== code.cc) {
      return oauthError("invalid_grant", "PKCE verification failed");
    }
    const redirectUri = form.get("redirect_uri");
    if (redirectUri && redirectUri !== code.ru) {
      return oauthError("invalid_grant", "redirect_uri does not match authorization request");
    }
    return issueTokens(integration.id, code.s, code.se - nowSeconds(), code.grant, env.SEAL_KEY);
  }

  if (grantType === "refresh_token") {
    const refresh = await unseal<RefreshPayload>(form.get("refresh_token") ?? "", env.SEAL_KEY);
    if (!refresh || refresh.t !== "refresh" || refresh.i !== integration.id) {
      return oauthError("invalid_grant", "Invalid refresh token");
    }
    try {
      // Stateless refresh: re-establish the upstream session from the sealed
      // grant (re-login for password integrations, upstream refresh-token
      // grant for OAuth ones).
      const r = await integration.refreshGrant(refresh.grant, env);
      return issueTokens(integration.id, r.session, r.expiresInSeconds, r.grant, env.SEAL_KEY);
    } catch {
      // The grant is dead (revoked, password changed). invalid_grant makes a
      // spec-compliant client discard its tokens and re-run the interactive
      // authorization flow — that is the recovery path.
      return oauthError("invalid_grant", "Upstream re-authentication failed; please re-authorize");
    }
  }

  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
}

async function issueTokens(
  integrationId: string,
  session: unknown,
  expiresInSeconds: number,
  grant: unknown,
  sealKey: string,
): Promise<Response> {
  const ttl = Math.min(Math.max(expiresInSeconds, 60), MAX_ACCESS_TTL);
  const accessToken = await seal(
    { t: "access", i: integrationId, s: session, exp: nowSeconds() + ttl } satisfies AccessPayload,
    sealKey,
  );
  const refreshToken = await seal({ t: "refresh", i: integrationId, grant } satisfies RefreshPayload, sealKey);
  return jsonResponse(
    { access_token: accessToken, token_type: "bearer", expires_in: ttl, refresh_token: refreshToken },
    200,
    { "Cache-Control": "no-store" }, // RFC 6749 §5.1
  );
}

// ---------------------------------------------------------------------------
// Bearer verification for /<id>/mcp
// ---------------------------------------------------------------------------

export async function verifyAccessToken(request: Request, integrationId: string, sealKey: string): Promise<AccessPayload | null> {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  const payload = await unseal<AccessPayload>(header.slice(7).trim(), sealKey);
  // `i` is the audience: a token sealed for /waitrose is garbage at /monzo.
  if (!payload || payload.t !== "access" || payload.i !== integrationId || payload.exp < nowSeconds()) return null;
  return payload;
}

export function unauthorized(origin: string, integrationId: string, description = "Missing or invalid access token"): Response {
  const resourceMetadata = `${origin}/.well-known/oauth-protected-resource/${integrationId}/mcp`;
  return jsonResponse({ error: "invalid_token", error_description: description }, 401, {
    "WWW-Authenticate": `Bearer error="invalid_token", error_description="${description}", resource_metadata="${resourceMetadata}"`,
  });
}
