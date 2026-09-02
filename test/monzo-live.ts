/**
 * Live Monzo proof. Holds every OAuth artifact in memory and prints no token.
 * A browser must visit the printed URL and complete the Monzo flow.
 */

const [base] = process.argv.slice(2);
if (!base) {
  console.error("usage: bun test/monzo-live.ts <worker-origin>");
  process.exit(1);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  ✓ ${message}`);
}

function parseRpc(raw: string): any {
  if (raw.trimStart().startsWith("{")) return JSON.parse(raw);
  const line = raw.split("\n").filter((candidate) => candidate.startsWith("data:")).pop();
  if (!line) throw new Error("MCP response did not contain JSON-RPC data");
  return JSON.parse(line.slice(5));
}

async function callTool(accessToken: string, name: string, args: object = {}, id = 1): Promise<any> {
  const response = await fetch(`${base}/monzo/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  return parseRpc(await response.text());
}

let callbackResolve!: (url: URL) => void;
const callbackPromise = new Promise<URL>((resolve) => {
  callbackResolve = resolve;
});
const callbackServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
    callbackResolve(url);
    return new Response(
      "<!doctype html><title>Monzo connected</title><h1>Connection returned to the MCP client</h1><p>You can close this tab. Approval may still be required in the Monzo app.</p>",
      { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
    );
  },
});

try {
  const redirectUri = `http://127.0.0.1:${callbackServer.port}/callback`;
  const registration = await fetch(`${base}/monzo/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Monzo live proof", redirect_uris: [redirectUri] }),
  });
  const client = (await registration.json()) as { client_id?: string };
  assert(registration.ok && client.client_id, "registered a temporary MCP OAuth client");

  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).toString("base64url");
  const authorization = new URL(`${base}/monzo/authorize`);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("client_id", client.client_id);
  authorization.searchParams.set("redirect_uri", redirectUri);
  authorization.searchParams.set("state", "monzo-live-proof");
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");

  console.log("\nBROWSER_URL", authorization.toString());
  console.log("Waiting for the browser OAuth flow…");

  const callback = await Promise.race([
    callbackPromise,
    Bun.sleep(10 * 60_000).then(() => {
      throw new Error("Timed out waiting for browser OAuth callback");
    }),
  ]);
  assert(callback.searchParams.get("state") === "monzo-live-proof", "outer OAuth state round-tripped");
  const code = callback.searchParams.get("code");
  assert(code, "received an MCP authorization code");

  const tokenResponse = await fetch(`${base}/monzo/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });
  const initial = (await tokenResponse.json()) as { access_token?: string; refresh_token?: string };
  assert(tokenResponse.ok && initial.access_token && initial.refresh_token, "exchanged the code without printing tokens");

  const whoami = await callTool(initial.access_token, "whoami");
  assert(whoami.result && !whoami.result.isError, "Monzo authenticated the live access token");

  // /ping/whoami succeeds before SCA data approval. /accounts is the real
  // readiness signal for the permission users grant in the Monzo app.
  let accounts: any;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    accounts = await callTool(initial.access_token, "list_accounts");
    if (accounts.result && !accounts.result.isError) break;
    if (attempt === 0) {
      console.log("\nAPPROVAL_REQUIRED Open the Monzo app and approve the pending developer access request now.");
    }
    await Bun.sleep(2_000);
  }
  assert(accounts?.result && !accounts.result.isError, "Monzo approved live account access");

  const refreshResponses = await Promise.all(
    Array.from({ length: 20 }, () =>
      fetch(`${base}/monzo/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: initial.refresh_token! }),
      }),
    ),
  );
  const refreshed = await Promise.all(
    refreshResponses.map(async (response) => ({
      ok: response.ok,
      body: (await response.json()) as { access_token?: string; refresh_token?: string },
    })),
  );
  assert(refreshed.every(({ ok, body }) => ok && body.access_token && body.refresh_token), "20 concurrent MCP refreshes succeeded");

  const concurrentWhoami = await Promise.all(
    refreshed.map(({ body }, index) => callTool(body.access_token!, "whoami", {}, index + 1)),
  );
  assert(concurrentWhoami.every((rpc) => rpc.result && !rpc.result.isError), "20 concurrent live Monzo MCP calls succeeded");

  const refreshedAccounts = await callTool(refreshed[0].body.access_token!, "list_accounts");
  assert(refreshedAccounts.result && !refreshedAccounts.result.isError, "list_accounts still works after concurrent refresh");
  const accountPayload = JSON.parse(refreshedAccounts.result.content[0].text) as { accounts?: unknown[] };
  console.log(`  ✓ live account count: ${accountPayload.accounts?.length ?? 0}`);
  console.log("\n✅ LIVE MONZO PLAYWRITER PROOF PASSED");
} finally {
  callbackServer.stop(true);
}
