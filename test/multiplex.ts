/**
 * End-to-end proof of the scope-multiplexed, stateless MCP server.
 *
 * Acts as an MCP client WITH SEP-2350 step-up support and a cookie-keeping
 * "browser" for the authorization wizard. Journey:
 *
 *   1. connect with no scopes  → only tool is connect_integration
 *   2. connect_integration(demo)     → 403 step-up → wizard (dummy provider consent) → demo tools
 *   3. connect_integration(waitrose) → 403 step-up → wizard (demo FAST-PASSES via cookie, waitrose form) → both
 *   4. refresh grant → snapshot refresh (demo carried forward, waitrose re-login)
 *   5. disconnect_integration(demo)  → 403 step-down → wizard (instant via cookie) → demo gone
 *
 * Usage: bun test/multiplex.ts <base-url> <waitrose-user> <waitrose-pass>
 */

const [base, wUser, wPass] = process.argv.slice(2);
if (!base || !wUser || !wPass) {
  console.error("usage: bun test/multiplex.ts <base-url> <username> <password>");
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

// --- the "browser": follows the wizard, keeps the sealed grant cookie -------
let cookie = "";
let sawInteractiveSteps: string[] = [];

function extractHidden(html: string, name: string): string {
  const m = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  if (!m) throw new Error(`hidden field ${name} not found in page`);
  return m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"');
}

async function browse(url: string, init?: RequestInit): Promise<{ code: string }> {
  const sameOrigin = url.startsWith(base);
  const res = await fetch(url, {
    ...init,
    redirect: "manual",
    headers: { ...(init?.headers ?? {}), ...(sameOrigin && cookie ? { Cookie: cookie } : {}) },
  });
  const setCookie = res.headers.get("set-cookie");
  if (sameOrigin && setCookie) cookie = setCookie.split(";")[0];

  if (res.status === 302) {
    const loc = res.headers.get("location")!;
    if (loc.startsWith(redirectUri)) {
      return { code: new URL(loc).searchParams.get("code")! };
    }
    return browse(loc); // provider redirect or back-to-wizard callback
  }

  if (res.status === 200 || res.status === 401) {
    const html = await res.text();
    if (html.includes("Connect your Waitrose account")) {
      sawInteractiveSteps.push("waitrose-form");
      const form = new URLSearchParams({
        wiz: extractHidden(html, "wiz"),
        integration: extractHidden(html, "integration"),
        username: wUser,
        password: wPass,
      });
      return browse(`${base}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
    }
    if (html.includes("Dummy OAuth Provider")) {
      sawInteractiveSteps.push("demo-consent");
      const form = new URLSearchParams({
        redirect_uri: extractHidden(html, "redirect_uri"),
        state: extractHidden(html, "state"),
        client_id: extractHidden(html, "client_id"),
        name: "Jonas T",
      });
      const providerOrigin = new URL(url).origin;
      return browse(`${providerOrigin}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
    }
    throw new Error(`unexpected wizard page (${res.status}): ${html.slice(0, 200)}`);
  }
  throw new Error(`unexpected wizard response ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

// --- the "MCP client": OAuth + JSON-RPC with step-up support ---------------
let clientId = "";
let tokens: { access_token: string; refresh_token: string; expires_in: number; scope: string };

async function authorize(scope: string): Promise<void> {
  sawInteractiveSteps = [];
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const u = new URL(`${base}/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", "s-" + Math.random().toString(36).slice(2, 8));
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (scope) u.searchParams.set("scope", scope);

  const { code } = await browse(u.toString());
  const res = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri }).toString(),
  });
  tokens = (await res.json()) as any;
  if (!res.ok || !tokens.access_token) throw new Error(`token exchange failed: ${JSON.stringify(tokens)}`);
}

/** POST a JSON-RPC request; on 403 insufficient_scope, re-authorize with the advertised scope and retry (SEP-2350). */
async function rpc(body: object, allowStepUp = true): Promise<any> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${tokens.access_token}`,
    },
    body: JSON.stringify(body),
  });
  if (res.status === 403 && allowStepUp) {
    const challenge = res.headers.get("www-authenticate") ?? "";
    const scopeMatch = challenge.match(/scope="([^"]*)"/);
    if (!scopeMatch) throw new Error(`403 without scope challenge: ${challenge}`);
    console.log(`  → 403 insufficient_scope, re-authorizing with scope="${scopeMatch[1]}"`);
    await authorize(scopeMatch[1]);
    return rpc(body, false); // retry once with the new token
  }
  const raw = await res.text();
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${raw.slice(0, 400)}`);
  return raw.trimStart().startsWith("{")
    ? JSON.parse(raw)
    : JSON.parse(raw.split("\n").filter((l) => l.startsWith("data:")).pop()!.slice(5));
}

const callTool = (name: string, args: object = {}) =>
  rpc({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method: "tools/call", params: { name, arguments: args } });
const listTools = async () =>
  ((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).result.tools as { name: string }[])
    .map((t) => t.name)
    .sort();

// ============================================================================
step("0. register client");
const reg = (await (
  await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "multiplex-test", redirect_uris: [redirectUri] }),
  })
).json()) as any;
clientId = reg.client_id;
assert(clientId, "client registered (client_id is a sealed blob)");

step("1. initial connect — no scopes");
await authorize("");
assert(sawInteractiveSteps.length === 0, "empty-scope authorize completed with zero user interaction");
assert(tokens.scope === "", "granted scope is empty");
let names = await listTools();
console.log("  tools:", names.join(", "));
assert(names.length === 1 && names[0] === "connect_integration", "connect_integration is the ONLY tool");

step("2. connect_integration(demo) — 403 step-up → dummy provider consent");
let result = await callTool("connect_integration", { integration: "demo" });
assert(sawInteractiveSteps.join(",") === "demo-consent", "wizard showed exactly the dummy provider consent");
assert(result.result.content[0].text.includes("✓"), `retried call confirms: ${result.result.content[0].text.slice(0, 60)}`);
assert(tokens.scope === "demo", "granted scope is now 'demo'");
names = await listTools();
console.log("  tools:", names.join(", "));
assert(names.includes("demo_whoami") && names.includes("list_integrations") && names.includes("disconnect_integration"), "demo + management tools appeared");
assert(!names.some((n) => n.startsWith("waitrose_")), "no waitrose tools yet");

result = await callTool("demo_whoami");
const me = JSON.parse(result.result.content[0].text);
assert(me.sub === "Jonas T" && me.plan === "gold", `demo_whoami works against the fake API (sub=${me.sub})`);

step("3. connect_integration(waitrose) — demo must FAST-PASS via cookie");
result = await callTool("connect_integration", { integration: "waitrose" });
assert(sawInteractiveSteps.join(",") === "waitrose-form", "wizard showed ONLY the waitrose form (demo fast-passed from sealed cookie)");
assert(tokens.scope.split(" ").sort().join(",") === "demo,waitrose", `granted scope is now '${tokens.scope}'`);
names = await listTools();
console.log("  tools:", names.join(", "));
assert(names.some((n) => n.startsWith("waitrose_")) && names.includes("demo_whoami"), "both integrations' tools present");

result = await callTool("waitrose_get_account_info");
const account = JSON.parse(result.result.content[0].text);
assert(account.email === wUser, `waitrose tools work (email=${account.email})`);

result = await callTool("list_integrations");
console.log("  list_integrations:", result.result.content[0].text.replace(/\n/g, " ").slice(0, 200));

step("4. refresh grant — snapshot refresh");
const refreshRes = await fetch(`${base}/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }).toString(),
});
tokens = (await refreshRes.json()) as any;
assert(refreshRes.ok && tokens.access_token, "refresh grant succeeded");
assert(tokens.scope.split(" ").sort().join(",") === "demo,waitrose", "refreshed bundle keeps both scopes");
result = await callTool("demo_whoami", {});
assert(JSON.parse(result.result.content[0].text).sub === "Jonas T", "demo session survives refresh");
result = await callTool("waitrose_get_trolley");
assert(JSON.parse(result.result.content[0].text).totals, "waitrose session works after refresh (re-login upstream)");

step("5. disconnect_integration(demo) — 403 step-down");
result = await callTool("disconnect_integration", { integration: "demo" });
assert(sawInteractiveSteps.length === 0, "step-down re-authorization was fully non-interactive (cookie fast-pass)");
assert(tokens.scope === "waitrose", `granted scope is now '${tokens.scope}'`);
assert(result.result.content[0].text.includes("✓"), `retried call confirms: ${result.result.content[0].text.slice(0, 60)}`);
names = await listTools();
console.log("  tools:", names.join(", "));
assert(!names.includes("demo_whoami"), "demo tools are gone");
assert(names.some((n) => n.startsWith("waitrose_")), "waitrose tools remain");

console.log("\n✅ MULTIPLEX JOURNEY PASSED");
