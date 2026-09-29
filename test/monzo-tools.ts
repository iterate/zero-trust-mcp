import { strict as assert } from "node:assert";
import type { McpServer } from "@modelcontextprotocol/server";
import { monzo } from "../src/integrations/monzo/index.js";

const tools = new Map<string, { config: any; handler: (args: any) => Promise<any> }>();
const server = {
  registerTool(name: string, config: any, handler: (args: any) => Promise<any>) {
    tools.set(name, { config, handler });
  },
} as unknown as McpServer;

monzo.registerTools(server, { accessToken: "test-access-token", userId: "user_test", apiOrigin: "https://monzo.test" });

assert.equal(tools.get("list_webhooks")!.config.annotations.readOnlyHint, true);
assert.equal(tools.get("register_webhook")!.config.annotations.idempotentHint, false);
assert.equal(tools.get("delete_webhook")!.config.annotations.destructiveHint, true);

const registerSchema = tools.get("register_webhook")!.config.inputSchema;
assert(registerSchema.safeParse({ account_id: "acc_1", url: "https://hooks.example/s3cret" }).success);
assert(!registerSchema.safeParse({ account_id: "acc_1", url: "http://hooks.example/s3cret" }).success, "plain HTTP is rejected");
assert(!registerSchema.safeParse({ account_id: "acc_1", url: "not a url" }).success);

const calls: { method: string; url: string; contentType: string | null; body: string | null }[] = [];
let failNetwork = false;
globalThis.fetch = (async (input, init) => {
  if (failNetwork) throw new TypeError("network down");
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("authorization"), "Bearer test-access-token");
  const call = {
    method: init?.method ?? "GET",
    url: String(input),
    contentType: headers.get("content-type"),
    body: init?.body ? String(init.body) : null,
  };
  calls.push(call);
  const webhook = { id: "webhook_1", account_id: "acc_1", url: "https://hooks.example/s3cret" };
  if (call.method === "POST") return Response.json({ webhook });
  if (call.method === "DELETE") return Response.json({});
  return Response.json({ webhooks: [webhook] });
}) as typeof fetch;

const registered = await tools.get("register_webhook")!.handler({ account_id: "acc_1", url: "https://hooks.example/s3cret" });
assert.deepEqual(calls.at(-1), {
  method: "POST",
  url: "https://monzo.test/webhooks",
  contentType: "application/x-www-form-urlencoded",
  body: "account_id=acc_1&url=https%3A%2F%2Fhooks.example%2Fs3cret",
});
assert.equal(registered.structuredContent.webhook.id, "webhook_1");

const listed = await tools.get("list_webhooks")!.handler({ account_id: "acc_1" });
assert.deepEqual(calls.at(-1), { method: "GET", url: "https://monzo.test/webhooks?account_id=acc_1", contentType: null, body: null });
assert.equal(listed.structuredContent.webhooks.length, 1);

const deleted = await tools.get("delete_webhook")!.handler({ webhook_id: "webhook_1/../x" });
assert.deepEqual(calls.at(-1), { method: "DELETE", url: "https://monzo.test/webhooks/webhook_1%2F..%2Fx", contentType: null, body: null });
assert.equal(deleted.structuredContent.deleted, "webhook_1/../x");

failNetwork = true;
await assert.rejects(
  tools.get("register_webhook")!.handler({ account_id: "acc_1", url: "https://hooks.example/s3cret" }),
  /outcome may be unknown/,
);

console.log("✅ Monzo webhook tool contract passed");
