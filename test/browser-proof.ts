/**
 * Browser-based proof: drive the hosted login page in a real (headless)
 * Chrome via agent-browser, then immediately exchange the resulting code.
 * agent-browser daemon occasionally flakes on response reads (os error 35),
 * so every CLI call tolerates read failures — the browser still acts.
 */

const redirectUri = "https://example.com/callback";
const [base, username, password] = process.argv.slice(2);
if (!base || !username || !password) {
  console.error("usage: bun test/browser-proof.ts <base-url> <username> <password>");
  process.exit(1);
}

const env = { ...process.env, AGENT_BROWSER_AUTO_CONNECT: "0" };
function ab(...args: string[]): string {
  const proc = Bun.spawnSync(["agent-browser", "--cdp", "9444", ...args], { env });
  return proc.stdout.toString().trim();
}

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

const reg = await (await fetch(`${base}/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ client_name: "browser-proof", redirect_uris: [redirectUri] }),
})).json() as any;

const u = new URL(`${base}/authorize`);
u.searchParams.set("response_type", "code");
u.searchParams.set("client_id", reg.client_id);
u.searchParams.set("redirect_uri", redirectUri);
u.searchParams.set("state", "browser-proof-2");
u.searchParams.set("scope", "waitrose");
u.searchParams.set("code_challenge", challenge);
u.searchParams.set("code_challenge_method", "S256");

console.log("opening login page in headless Chrome…");
ab("open", u.toString());
ab("find", "label", "Email", "fill", username);
ab("find", "label", "Password", "fill", password);
console.log("submitting…");
ab("find", "role", "button", "click", "--name", "Sign in & authorize");

let code = "";
const t0 = Date.now();
while (Date.now() - t0 < 30_000) {
  const url = ab("get", "url");
  if (url.startsWith(redirectUri)) {
    const landed = new URL(url);
    console.log("browser landed on:", landed.origin + landed.pathname, "| state:", landed.searchParams.get("state"));
    code = landed.searchParams.get("code")!;
    break;
  }
  await Bun.sleep(500);
}
if (!code) throw new Error("browser never reached the callback URL");

const tokens = await (await fetch(`${base}/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri }).toString(),
})).json() as any;
if (!tokens.access_token) throw new Error(JSON.stringify(tokens));
console.log("token exchange OK, expires_in:", tokens.expires_in);

const mcpRes = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${tokens.access_token}`,
  },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "search_products", arguments: { query: "sourdough bread", size: 2 } },
  }),
});
const raw = await mcpRes.text();
const mcp = raw.trimStart().startsWith("{")
  ? JSON.parse(raw)
  : JSON.parse(raw.split("\n").filter((l) => l.startsWith("data:")).pop()!.slice(5));
console.log("\nMCP tools/call with the browser-issued token:");
console.log(mcp.result.content[0].text);
console.log("\n✅ BROWSER PROOF PASSED");
