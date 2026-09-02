/**
 * Public-boundary proof for Monzo's rotating refresh token.
 *
 * This starts the real Worker locally (including its Durable Object) against
 * a deliberately strict fake Monzo provider. The provider accepts each
 * refresh token once and delays rotation so concurrent requests overlap.
 *
 * Proves:
 *   1. BYO-client OAuth completes through /monzo/authorize + /monzo/callback.
 *   2. Twenty concurrent MCP refresh grants cause exactly one upstream refresh.
 *   3. Every returned access token supports a concurrent MCP tool call.
 *   4. Durable Object persistence contains none of the credential/token sentinels.
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_CLIENT_ID = "test-monzo-client";
const FAKE_CLIENT_SECRET = "test-client-secret-must-never-persist";
const INITIAL_ACCESS = "test-access-token-zero-must-never-persist";
const INITIAL_REFRESH = "test-refresh-token-zero-must-never-persist";
const ROTATED_ACCESS = "test-access-token-one-must-never-persist";
const ROTATED_REFRESH = "test-refresh-token-one-must-never-persist";
const SEAL_KEY = Buffer.alloc(32, 7).toString("base64");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  ✓ ${message}`);
}

function hidden(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  if (!match) throw new Error(`Missing hidden field ${name}`);
  return match[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"');
}

function linkHref(html: string, label: string): string {
  const match = html.match(new RegExp(`<a[^>]+href="([^"]+)"[^>]*>${label}</a>`));
  if (!match) throw new Error(`Missing link ${label}`);
  return match[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"');
}

function parseRpc(raw: string): any {
  if (raw.trimStart().startsWith("{")) return JSON.parse(raw);
  const line = raw
    .split("\n")
    .filter((candidate) => candidate.startsWith("data:"))
    .pop();
  if (!line) throw new Error(`No JSON-RPC payload in response: ${raw.slice(0, 200)}`);
  return JSON.parse(line.slice(5));
}

async function waitUntilReady(origin: string, process: ReturnType<typeof Bun.spawn>) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`wrangler exited early (${process.exitCode})`);
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      // Worker is still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error("Timed out waiting for wrangler dev");
}

async function walkFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? walkFiles(path) : [path];
    }),
  );
  return nested.flat();
}

let upstreamRefreshes = 0;
let currentRefresh = INITIAL_REFRESH;
let currentAccess = INITIAL_ACCESS;
let accountAccessApproved = false;

const upstream = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/authorize") {
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", "fake-monzo-code");
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      return Response.redirect(redirect.toString(), 302);
    }

    if (url.pathname === "/oauth2/token" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      if (form.get("client_id") !== FAKE_CLIENT_ID || form.get("client_secret") !== FAKE_CLIENT_SECRET) {
        return Response.json({ error: "invalid_client" }, { status: 401 });
      }
      if (form.get("grant_type") === "authorization_code") {
        return Response.json({
          access_token: INITIAL_ACCESS,
          refresh_token: INITIAL_REFRESH,
          // Force the MCP refresh path to rotate upstream immediately.
          expires_in: 30,
          user_id: "user_test",
          token_type: "Bearer",
        });
      }
      if (form.get("grant_type") === "refresh_token") {
        upstreamRefreshes += 1;
        const presented = form.get("refresh_token");
        await Bun.sleep(200);
        if (presented !== currentRefresh) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        currentAccess = ROTATED_ACCESS;
        currentRefresh = ROTATED_REFRESH;
        return Response.json({
          access_token: ROTATED_ACCESS,
          refresh_token: ROTATED_REFRESH,
          expires_in: 3600,
          user_id: "user_test",
          token_type: "Bearer",
        });
      }
      return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    }

    if (url.pathname === "/ping/whoami") {
      const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (bearer !== currentAccess) return Response.json({ authenticated: false }, { status: 401 });
      return Response.json({ authenticated: true, user_id: "user_test" });
    }

    if (url.pathname === "/accounts") {
      const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (bearer !== currentAccess) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (!accountAccessApproved) return Response.json({ error: "approval_required" }, { status: 403 });
      return Response.json({ accounts: [{ id: "acc_test", type: "uk_retail" }] });
    }

    return new Response("Not found", { status: 404 });
  },
});

const persistDir = await mkdtemp(join(tmpdir(), "zero-trust-monzo-test-"));
const workerPort = 20_000 + Math.floor(Math.random() * 20_000);
const workerOrigin = `http://127.0.0.1:${workerPort}`;
const upstreamOrigin = `http://127.0.0.1:${upstream.port}`;
const worker = Bun.spawn(
  [
    "bunx",
    "wrangler",
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(workerPort),
    "--persist-to",
    persistDir,
    "--var",
    `SEAL_KEY:${SEAL_KEY}`,
    "--var",
    `MONZO_API_ORIGIN:${upstreamOrigin}`,
    "--var",
    `MONZO_AUTH_ORIGIN:${upstreamOrigin}`,
  ],
  { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
);

try {
  await waitUntilReady(workerOrigin, worker);

  console.log("\n=== Monzo OAuth onboarding ===");
  const redirectUri = "http://127.0.0.1:33419/callback";
  const registration = await fetch(`${workerOrigin}/monzo/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "monzo-race-test", redirect_uris: [redirectUri] }),
  });
  const registered = (await registration.json()) as { client_id?: string };
  assert(registration.ok && registered.client_id, "dynamic client registration succeeds");

  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).toString("base64url");
  const authorize = new URL(`${workerOrigin}/monzo/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", registered.client_id);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("state", "monzo-race-test");
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");

  const setupResponse = await fetch(authorize, { redirect: "manual" });
  const setupHtml = await setupResponse.text();
  assert(setupResponse.ok && setupHtml.includes("Monzo"), "authorize renders BYO Monzo client setup");
  assert(setupHtml.includes('viewBox="0 0 138 24"'), "authorize uses Monzo's official wordmark");
  assert(setupHtml.includes("Not affiliated with or endorsed by Monzo Bank Limited"), "authorize disclaims Monzo affiliation");
  assert(
    setupResponse.headers.get("content-security-policy")?.includes("form-action 'self' https:"),
    "setup policy permits the browser's redirect to an HTTPS OAuth provider",
  );

  const upstreamRedirect = await fetch(`${workerOrigin}/monzo/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      state: hidden(setupHtml, "state"),
      client_id: FAKE_CLIENT_ID,
      client_secret: FAKE_CLIENT_SECRET,
    }),
    redirect: "manual",
  });
  assert(upstreamRedirect.status === 302, "setup redirects to Monzo authorization");

  const upstreamConsent = await fetch(upstreamRedirect.headers.get("location")!, { redirect: "manual" });
  const callback = await fetch(upstreamConsent.headers.get("location")!, { redirect: "manual" });
  const approvalHtml = await callback.text();
  assert(callback.ok && approvalHtml.includes("Approve in the Monzo app"), "callback renders provider-declared approval guidance");

  const pending = await fetch(`${workerOrigin}/monzo/complete`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ handoff: hidden(approvalHtml, "handoff") }),
  });
  const pendingHtml = await pending.text();
  assert(pending.ok && pendingHtml.includes("Still waiting for Monzo"), "generic completion route keeps a pending provider pending");

  accountAccessApproved = true;
  const ready = await fetch(`${workerOrigin}/monzo/complete`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ handoff: hidden(pendingHtml, "handoff") }),
  });
  const readyHtml = await ready.text();
  assert(ready.ok && readyHtml.includes("Monzo is connected"), "generic completion route renders the provider's ready state");

  const outerRedirect = new URL(linkHref(readyHtml, "Return to your MCP client"));
  assert(outerRedirect.origin + outerRedirect.pathname === redirectUri, "callback returns to the MCP client");
  assert(outerRedirect.searchParams.get("state") === "monzo-race-test", "outer OAuth state round-trips");

  const tokenResponse = await fetch(`${workerOrigin}/monzo/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: outerRedirect.searchParams.get("code")!,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });
  const initialTokens = (await tokenResponse.json()) as { access_token?: string; refresh_token?: string };
  assert(tokenResponse.ok && initialTokens.refresh_token, "authorization code exchange returns MCP tokens");

  console.log("\n=== Concurrent refresh coordination ===");
  const refreshResponses = await Promise.all(
    Array.from({ length: 20 }, () =>
      fetch(`${workerOrigin}/monzo/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: initialTokens.refresh_token! }),
      }),
    ),
  );
  const refreshed = await Promise.all(
    refreshResponses.map(async (response) => ({
      ok: response.ok,
      body: (await response.json()) as { access_token?: string; refresh_token?: string; error?: string },
    })),
  );
  assert(refreshed.every(({ ok, body }) => ok && body.access_token && body.refresh_token), "all 20 refresh requests succeed");
  assert(upstreamRefreshes === 1, "the burst performs exactly one upstream token rotation");

  console.log("\n=== Concurrent MCP tools after rotation ===");
  const toolCalls = await Promise.all(
    refreshed.map(({ body }, index) =>
      fetch(`${workerOrigin}/monzo/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${body.access_token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: index + 1,
          method: "tools/call",
          params: { name: "whoami", arguments: {} },
        }),
      }),
    ),
  );
  const toolResults = await Promise.all(toolCalls.map(async (response) => ({ response, rpc: parseRpc(await response.text()) })));
  assert(toolResults.every(({ response, rpc }) => response.ok && rpc.result && !rpc.error), "all 20 concurrent MCP tool calls succeed");

  worker.kill();
  await worker.exited;

  console.log("\n=== Persistent-state scan ===");
  const files = await walkFiles(persistDir);
  const persisted = Buffer.concat(await Promise.all(files.map((file) => readFile(file))));
  for (const sentinel of [FAKE_CLIENT_SECRET, INITIAL_ACCESS, INITIAL_REFRESH, ROTATED_ACCESS, ROTATED_REFRESH]) {
    assert(!persisted.includes(Buffer.from(sentinel)), `Durable storage does not contain ${sentinel.split("-").slice(0, 3).join("-")}`);
  }

  console.log("\n✅ MONZO CONCURRENCY PROOF PASSED");
} finally {
  if (worker.exitCode === null) {
    worker.kill();
    await worker.exited;
  }
  upstream.stop(true);
  await rm(persistDir, { recursive: true, force: true });
}
