/**
 * End-to-end proof of the path-per-integration stateless MCP server.
 * Acts as a spec-compliant MCP client against the Waitrose endpoint:
 *
 *   /waitrose/mcp — password integration (real Waitrose login)
 *
 * Covers: discovery from the 401 challenge, DCR, authorize, PKCE (positive
 * and negative), tool calls, refresh grant, and cross-integration audience
 * rejection (a waitrose token must be garbage at /monzo/mcp).
 *
 * Usage: bun test/journey.ts <base-url> <waitrose-user> <waitrose-pass>
 */

const [base, wUser, wPass] = process.argv.slice(2);
if (!base || !wUser || !wPass) {
  console.error("usage: bun test/journey.ts <base-url> <username> <password>");
  process.exit(1);
}

const redirectUri = "http://localhost:33418/callback";
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

function step(name: string) {
  console.log(`\n=== ${name} ===`);
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}
function extractHidden(html: string, name: string): string {
  const m = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  if (!m) throw new Error(`hidden field ${name} not found`);
  return m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"');
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/** Full spec-compliant connect against one integration endpoint. */
async function connect(id: string): Promise<{ tokens: Tokens; meta: any }> {
  // 1. Hit the MCP endpoint unauthenticated; follow the WWW-Authenticate pointer.
  const bare = await fetch(`${base}/${id}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert(bare.status === 401, `${id}: unauthenticated /mcp → 401`);
  const challenge = bare.headers.get("www-authenticate") ?? "";
  const prmUrl = challenge.match(/resource_metadata="([^"]+)"/)?.[1];
  assert(prmUrl, `${id}: 401 advertises resource_metadata (${prmUrl})`);

  const prm = (await (await fetch(prmUrl!)).json()) as any;
  assert(prm.resource === `${base}/${id}/mcp`, `${id}: PRM resource matches endpoint`);
  const issuer = prm.authorization_servers[0];

  // 2. RFC 8414 path-insertion discovery for an issuer with a path component.
  const issuerUrl = new URL(issuer);
  const meta = (await (await fetch(`${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname}`)).json()) as any;
  assert(meta.issuer === issuer, `${id}: AS metadata issuer matches (${issuer})`);

  // 3. Dynamic client registration.
  const reg = (await (
    await fetch(meta.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "journey-test", redirect_uris: [redirectUri] }),
    })
  ).json()) as any;
  assert(reg.client_id, `${id}: registered client`);

  // 4. Authorization code flow with PKCE.
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge256 = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", reg.client_id);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", "journey");
  u.searchParams.set("code_challenge", challenge256);
  u.searchParams.set("code_challenge_method", "S256");

  const code = await driveUserThrough(u.toString(), id);

  const tokenRes = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri }).toString(),
  });
  const tokens = (await tokenRes.json()) as Tokens;
  assert(tokenRes.ok && tokens.access_token, `${id}: PKCE token exchange succeeded (expires_in ${tokens.expires_in}s)`);

  // Negative: a replayed code with the wrong verifier must fail.
  const bad = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: "wrong-".padEnd(43, "x"), redirect_uri: redirectUri }).toString(),
  });
  assert(bad.status === 400, `${id}: wrong PKCE verifier rejected`);

  return { tokens, meta };
}

/** Simulate the human filling the Waitrose login form. */
async function driveUserThrough(authorizeUrl: string, id: string): Promise<string> {
  let res = await fetch(authorizeUrl, { redirect: "manual" });
  for (let hops = 0; hops < 6; hops++) {
    if (res.status === 302) {
      const loc = res.headers.get("location")!;
      if (loc.startsWith(redirectUri)) {
        const landed = new URL(loc);
        assert(landed.searchParams.get("state") === "journey", `${id}: state round-tripped`);
        return landed.searchParams.get("code")!;
      }
      res = await fetch(loc, { redirect: "manual" });
      continue;
    }
    const html = await res.text();
    if (html.includes("Connect your Waitrose account")) {
      console.log(`  → filling the Waitrose login form (real upstream login)`);
      res = await fetch(`${base}/waitrose/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ state: extractHidden(html, "state"), username: wUser, password: wPass }).toString(),
        redirect: "manual",
      });
      continue;
    }
    throw new Error(`unexpected page (${res.status}): ${html.slice(0, 200)}`);
  }
  throw new Error("too many redirects");
}

async function callTool(id: string, accessToken: string, name: string, args: object = {}): Promise<any> {
  const res = await fetch(`${base}/${id}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${raw.slice(0, 300)}`);
  const rpc = raw.trimStart().startsWith("{")
    ? JSON.parse(raw)
    : JSON.parse(raw.split("\n").filter((l) => l.startsWith("data:")).pop()!.slice(5));
  return rpc;
}

async function listToolNames(id: string, accessToken: string): Promise<string[]> {
  const res = await fetch(`${base}/${id}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const raw = await res.text();
  const rpc = raw.trimStart().startsWith("{")
    ? JSON.parse(raw)
    : JSON.parse(raw.split("\n").filter((l) => l.startsWith("data:")).pop()!.slice(5));
  return (rpc.result.tools as { name: string }[]).map((t) => t.name).sort();
}

// ============================================================================

step("waitrose: full connect");
const w = await connect("waitrose");
console.log("  tools:", (await listToolNames("waitrose", w.tokens.access_token)).join(", "));
let out = await callTool("waitrose", w.tokens.access_token, "get_account_info");
assert(JSON.parse(out.result.content[0].text).email === wUser, "get_account_info returns the real account");
out = await callTool("waitrose", w.tokens.access_token, "search_products", { query: "oat milk", size: 2 });
assert(JSON.parse(out.result.content[0].text).totalMatches > 0, "search_products returns live results");

step("audience binding: tokens are path-scoped");
const cross = await fetch(`${base}/monzo/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${w.tokens.access_token}` },
  body: "{}",
});
assert(cross.status === 401, "waitrose access token is rejected at /monzo/mcp");

step("refresh grants (stateless upstream re-auth)");
for (const [id, t] of [["waitrose", w.tokens]] as const) {
  const res = await fetch(`${base}/${id}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token }).toString(),
  });
  const refreshed = (await res.json()) as Tokens;
  assert(res.ok && refreshed.access_token, `${id}: refresh grant succeeded`);
  const tool = "get_account_info";
  const check = await callTool(id, refreshed.access_token, tool);
  assert(check.result?.content?.[0]?.text, `${id}: refreshed token works (${tool})`);
}

step("dead grant → invalid_grant (the recovery ladder)");
const deadRes = await fetch(`${base}/waitrose/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "AQ" + w.tokens.refresh_token.slice(2) }).toString(),
});
assert(deadRes.status === 400 && ((await deadRes.json()) as any).error === "invalid_grant", "tampered refresh token → invalid_grant");

console.log("\n✅ JOURNEY PASSED");
