/**
 * Public-boundary proof for Yoto's rotating refresh token.
 *
 * This starts the real Worker locally (including its Durable Object) against
 * a deliberately strict fake Yoto provider. The provider accepts each
 * refresh token once and delays rotation so concurrent requests overlap.
 *
 * Proves:
 *   1. BYO-client OAuth completes through /yoto/authorize + /yoto/callback.
 *   2. Twenty concurrent MCP refresh grants cause exactly one upstream refresh.
 *   3. Every returned access token supports a concurrent MCP tool call.
 *   4. Durable Object persistence contains none of the credential/token sentinels.
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_CLIENT_ID = "test-yoto-client";
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
let apiStatus = 200;
let tokenMode = "valid";
let createdCard: any;
let apiCalls = 0;

const upstream = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/authorize") {
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", "fake-yoto-code");
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      return Response.redirect(redirect.toString(), 302);
    }

    if (url.pathname === "/oauth/token" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      if (form.get("client_id") !== FAKE_CLIENT_ID || form.get("client_secret") !== FAKE_CLIENT_SECRET) {
        return Response.json({ error: "invalid_client" }, { status: 401 });
      }
      if (form.get("grant_type") === "authorization_code") {
        assert(form.get("code") === "fake-yoto-code" && form.get("redirect_uri") === `${workerOrigin}/yoto/callback`, "upstream code exchange binds the code and callback");
        if (tokenMode === "missing-refresh") return Response.json({ access_token: INITIAL_ACCESS, expires_in: 30, token_type: "Bearer" });
        if (tokenMode === "malformed") return new Response(FAKE_CLIENT_SECRET);
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

    if (url.pathname === "/device-v2/devices/mine" || url.pathname === "/content/mine" ||
        url.pathname === "/content/card_test" || url.pathname === "/content" ||
        url.pathname === "/card/family/library/groups" || url.pathname === "/card/family/library/groups/group_test") {
      apiCalls++;
      if (apiStatus !== 200) return new Response(FAKE_CLIENT_SECRET, { status: apiStatus });
      const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (bearer !== currentAccess) return Response.json({ authenticated: false }, { status: 401 });
      if (url.pathname === "/content" && request.method === "POST") {
        createdCard = await request.json();
        return Response.json({ card: { cardId: "new_card", ...createdCard } });
      }
      if (url.pathname === "/device-v2/devices/mine") return Response.json({ devices: [{ deviceId: "player_test", name: "Bedroom", online: true }] });
      if (url.pathname === "/content/mine") return Response.json({ cards: [{ cardId: "card_test", title: "Story" }] });
      if (url.pathname === "/content/card_test") return Response.json({ card: { cardId: "card_test", content: { chapters: [] } } });
      if (url.pathname.endsWith("/group_test")) return Response.json({ id: "group_test", cards: [{ cardId: "card_test" }] });
      return Response.json([{ id: "group_test", name: "Favourites" }]);
    }

    return new Response("Not found", { status: 404 });
  },
});

const persistDir = await mkdtemp(join(tmpdir(), "zero-trust-yoto-test-"));
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
    `YOTO_API_ORIGIN:${upstreamOrigin}`,
    "--var",
    `YOTO_AUTH_ORIGIN:${upstreamOrigin}`,
  ],
  { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
);

try {
  await waitUntilReady(workerOrigin, worker);

  console.log("\n=== Yoto OAuth onboarding ===");
  const redirectUri = "http://127.0.0.1:33419/callback";
  const registration = await fetch(`${workerOrigin}/yoto/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "yoto-test", redirect_uris: [redirectUri] }),
  });
  const registered = (await registration.json()) as { client_id?: string };
  assert(registration.ok && registered.client_id, "dynamic client registration succeeds");

  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).toString("base64url");
  const authorize = new URL(`${workerOrigin}/yoto/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", registered.client_id);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("state", "yoto-race-test");
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");

  const setupResponse = await fetch(authorize, { redirect: "manual" });
  const setupHtml = await setupResponse.text();
  assert(setupResponse.ok && setupHtml.includes("Yoto"), "authorize renders BYO Yoto client setup");
  assert(setupHtml.includes("Not affiliated with or endorsed by Yoto"), "authorize disclaims Yoto affiliation");
  assert(
    setupResponse.headers.get("content-security-policy")?.includes("form-action 'self' https:"),
    "setup policy permits the browser's redirect to an HTTPS OAuth provider",
  );

  const upstreamRedirect = await fetch(`${workerOrigin}/yoto/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      state: hidden(setupHtml, "state"),
      client_id: FAKE_CLIENT_ID,
      client_secret: FAKE_CLIENT_SECRET,
    }),
    redirect: "manual",
  });
  assert(upstreamRedirect.status === 302, "setup redirects to Yoto authorization");

  const consentUrl = new URL(upstreamRedirect.headers.get("location")!);
  assert(consentUrl.searchParams.get("audience") === "https://api.yotoplay.com", "requests the Yoto API audience");
  assert(consentUrl.searchParams.get("scope") === "family:library:view user:content:manage family:devices:view offline_access", "requests the supported tool scopes and refresh access");
  assert(!consentUrl.toString().includes(FAKE_CLIENT_SECRET), "client secret is not exposed in the consent URL");
  const upstreamConsent = await fetch(consentUrl, { redirect: "manual" });
  for (const mode of ["missing-refresh", "malformed"]) {
    tokenMode = mode;
    const rejected = await fetch(upstreamConsent.headers.get("location")!, { redirect: "manual" });
    const rejectedText = await rejected.text();
    assert(rejected.status === 400 && !rejectedText.includes(FAKE_CLIENT_SECRET), `${mode} token response fails without leaking credentials`);
  }
  tokenMode = "valid";
  const callback = await fetch(upstreamConsent.headers.get("location")!, { redirect: "manual" });
  if (callback.status !== 302) throw new Error(`Callback failed: ${await callback.text()}`);
  assert(callback.status === 302, "Yoto callback completes without an extra approval step");
  const outerRedirect = new URL(callback.headers.get("location")!);
  assert(outerRedirect.origin + outerRedirect.pathname === redirectUri, "callback returns to the MCP client");
  assert(outerRedirect.searchParams.get("state") === "yoto-race-test", "outer OAuth state round-trips");

  const invalidPkce = await fetch(`${workerOrigin}/yoto/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code: outerRedirect.searchParams.get("code")!, code_verifier: "wrong" }),
  });
  assert(invalidPkce.status === 400, "wrong MCP PKCE verifier is rejected");

  const tokenResponse = await fetch(`${workerOrigin}/yoto/token`, {
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
      fetch(`${workerOrigin}/yoto/token`, {
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
      fetch(`${workerOrigin}/yoto/mcp`, {
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
          params: { name: "list_players", arguments: {} },
        }),
      }),
    ),
  );
  const toolResults = await Promise.all(toolCalls.map(async (response) => ({ response, rpc: parseRpc(await response.text()) })));
  assert(toolResults.every(({ response, rpc }) => response.ok && rpc.result && !rpc.error && !rpc.result.isError), "all 20 concurrent MCP tool calls succeed");

  const accessToken = refreshed[0].body.access_token!;
  async function rpc(method: string, params: unknown, token = accessToken, provider = "yoto") {
    const response = await fetch(`${workerOrigin}/${provider}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 100, method, params }),
    });
    return { response, message: parseRpc(await response.text()) };
  }
  async function call(name: string, args = {}) {
    const { response, message } = await rpc("tools/call", { name, arguments: args });
    assert(response.ok && message.result && !message.result.isError, `${name} succeeds through MCP`);
    return JSON.parse(message.result.content[0].text);
  }
  const { message: listing } = await rpc("tools/list", {});
  assert(listing.result.tools.length === 6, "all six Yoto tools are discoverable");
  assert(listing.result.tools.find((t: any) => t.name === "create_streaming_card").annotations.idempotentHint === false, "creation is marked non-idempotent");
  assert((await call("list_myo_cards")).cards[0].cardId === "card_test", "MYO response survives MCP serialization");
  assert((await call("get_card", { cardId: "card_test" })).card.content.chapters.length === 0, "card details include chapters");
  assert((await call("list_library_groups"))[0].id === "group_test", "group list supports array responses");
  assert((await call("get_library_group", { groupId: "group_test" })).cards.length === 1, "group details include cards");
  await call("create_streaming_card", { title: "Bedtime", tracks: [
    { title: "First", url: "https://example.com/one.mp3" },
    { title: "Second", url: "https://example.com/two.aac", format: "aac" },
  ] });
  assert(createdCard.content.chapters[0].tracks[0].type === "stream", "creates streaming tracks");
  assert(createdCard.content.chapters[0].tracks[0].format === "mp3", "defaults track format to MP3");
  assert(createdCard.content.chapters[1].key === "02" && createdCard.content.chapters[1].tracks[0].format === "aac", "preserves chapter order and explicit format");
  assert(!createdCard.cardId, "creation never accidentally updates an existing card");

  const beforeInvalid = apiCalls;
  for (const [name, args] of [
    ["get_card", { cardId: "../mine?token=oops" }],
    ["get_library_group", { groupId: ".." }],
    ["create_streaming_card", { title: "Empty", tracks: [] }],
    ["create_streaming_card", { title: "Local", tracks: [{ title: "Invalid", url: "file:///etc/passwd" }] }],
  ] as const) {
    const { message } = await rpc("tools/call", { name, arguments: args });
    assert(message.error || message.result?.isError, `${name} rejects invalid input`);
  }
  assert(apiCalls === beforeInvalid, "invalid arguments never reach Yoto");
  for (const status of [401, 403, 404, 429, 500]) {
    apiStatus = status;
    const { message } = await rpc("tools/call", { name: "list_players", arguments: {} });
    assert(message.error || message.result?.isError, `upstream ${status} is a tool error`);
    assert(!JSON.stringify(message).includes(FAKE_CLIENT_SECRET), "upstream error body never leaks to MCP");
  }
  apiStatus = 200;
  const wrongAudience = await fetch(`${workerOrigin}/waitrose/mcp`, { headers: { authorization: `Bearer ${accessToken}` } });
  assert(wrongAudience.status === 401, "Yoto token cannot authorize Waitrose");

  // A valid upstream access token should simply be rewrapped.
  const reuse = await fetch(`${workerOrigin}/yoto/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshed[0].body.refresh_token! }),
  });
  assert(reuse.ok && upstreamRefreshes === 1, "refresh reuses unexpired upstream access without rotating again");

  console.log("Waiting for the coordinator's bounded retry window to expire...");
  await Bun.sleep(31_000);
  const stale = await fetch(`${workerOrigin}/yoto/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: initialTokens.refresh_token! }),
  });
  assert(stale.status === 400 && (await stale.json() as any).error === "invalid_grant", "stale refresh generations require reauthorization");
  assert(upstreamRefreshes === 1, "stale refresh is rejected before replaying Yoto's single-use token");

  worker.kill();
  await worker.exited;

  console.log("\n=== Persistent-state scan ===");
  const files = await walkFiles(persistDir);
  const persisted = Buffer.concat(await Promise.all(files.map((file) => readFile(file))));
  for (const sentinel of [FAKE_CLIENT_SECRET, INITIAL_ACCESS, INITIAL_REFRESH, ROTATED_ACCESS, ROTATED_REFRESH]) {
    assert(!persisted.includes(Buffer.from(sentinel)), `Durable storage does not contain ${sentinel.split("-").slice(0, 3).join("-")}`);
  }

  console.log("\n✅ YOTO CONCURRENCY PROOF PASSED");
} finally {
  if (worker.exitCode === null) {
    worker.kill();
    await worker.exited;
  }
  upstream.stop(true);
  await rm(persistDir, { recursive: true, force: true });
}
