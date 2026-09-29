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

assert.equal(tools.get("get_transaction")!.config.annotations.readOnlyHint, true);
assert.equal(tools.get("list_webhooks")!.config.annotations.readOnlyHint, true);
assert.equal(tools.get("register_webhook")!.config.annotations.idempotentHint, false);
assert.equal(tools.get("delete_webhook")!.config.annotations.destructiveHint, true);
assert.equal(tools.get("create_receipt")!.config.annotations.idempotentHint, true);
assert.equal(tools.get("get_receipt")!.config.annotations.readOnlyHint, true);

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
  const path = new URL(call.url).pathname;
  if (path === "/transaction-receipts") {
    if (call.method === "PUT") {
      if (JSON.parse(call.body!).transaction_id === "tx_not_mine") {
        return Response.json({
          code: "forbidden.insufficient_permissions",
          message: "Access forbidden due to insufficient permissions",
          params: { client_id: "oauth2client_secretish", user_id: "user_test" },
        }, { status: 403 });
      }
      return new Response(null, { status: 200 }); // Monzo documents an empty success body.
    }
    if (call.method === "DELETE") return Response.json({});
    return Response.json({ receipt: { id: "receipt_1", external_id: "waitrose-1" } });
  }
  if (path.startsWith("/transactions/")) {
    return Response.json({ transaction: { id: "tx_1", amount: -1234, currency: "GBP", notes: "lunch", merchant: { name: "Deli" } } });
  }
  const webhook = { id: "webhook_1", account_id: "acc_1", url: "https://hooks.example/s3cret" };
  if (call.method === "POST") return Response.json({ webhook });
  if (call.method === "DELETE") return Response.json({});
  return Response.json({ webhooks: [webhook] });
}) as typeof fetch;

const transaction = await tools.get("get_transaction")!.handler({ transaction_id: "tx_1" });
assert.deepEqual(calls.at(-1), {
  method: "GET",
  url: "https://monzo.test/transactions/tx_1?expand%5B%5D=merchant",
  contentType: null,
  body: null,
});
assert.equal(transaction.structuredContent.transaction.notes, "lunch");
assert.equal(transaction.structuredContent.transaction.formatted, "-£12.34");

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

const receiptTool = tools.get("create_receipt")!;
const receiptInput = {
  transaction_id: "tx_1",
  external_id: "waitrose-1",
  total: 1000,
  items: [
    { description: "Bananas", amount: 300, quantity: 1.5, unit: "kg" },
    { description: "Milk", amount: 800, sub_items: [{ description: "Offer", amount: -100 }, { description: "Milk x2", amount: 900 }] },
    { description: "Offer", amount: -100 },
  ],
  payments: [{ type: "card", amount: 1000, last_four: "1234" }],
  merchant: { name: "Waitrose", online: true },
};
const saved = await receiptTool.handler(receiptTool.config.inputSchema.parse(receiptInput));
assert.equal(calls.at(-1)!.method, "PUT");
assert.equal(calls.at(-1)!.url, "https://monzo.test/transaction-receipts");
assert.equal(calls.at(-1)!.contentType, "application/json");
const sent = JSON.parse(calls.at(-1)!.body!);
assert(!calls.at(-1)!.body!.includes("null"), "receipt body contains no nulls");
assert.deepEqual(sent.items[0], { description: "Bananas", amount: 300, quantity: 1.5, unit: "kg", tax: 0, currency: "GBP", sub_items: [] });
assert.deepEqual(sent.items[1].sub_items[0], { description: "Offer", amount: -100, quantity: 1, unit: "", tax: 0, currency: "GBP" });
assert.deepEqual(sent.taxes, []);
assert.deepEqual(sent.payments, [{ type: "card", amount: 1000, last_four: "1234", currency: "GBP" }]);
assert.deepEqual(sent.merchant, { name: "Waitrose", online: true });
assert.equal(sent.currency, "GBP");
assert.deepEqual(saved.structuredContent.warnings, []);
assert.equal(saved.structuredContent.receipt_id, undefined);

const mismatched = await receiptTool.handler(receiptTool.config.inputSchema.parse({
  ...receiptInput,
  total: 1200,
  items: [{ description: "Milk", amount: 800, sub_items: [{ description: "Milk", amount: 700 }] }],
}));
assert.deepEqual(mismatched.structuredContent.warnings, [
  "Items plus taxes sum to 800, not the total 1200",
  "Payments sum to 1000, not the total 1200",
  'Sub-items of "Milk" sum to 700, not its amount 800',
]);
assert(!receiptTool.config.inputSchema.safeParse({ ...receiptInput, items: [] }).success, "receipts need an item");
assert(!receiptTool.config.inputSchema.safeParse({ ...receiptInput, total: -1000 }).success, "total is positive");

await assert.rejects(
  receiptTool.handler(receiptTool.config.inputSchema.parse({ ...receiptInput, transaction_id: "tx_not_mine" })),
  (error: Error) => error.message.includes("forbidden.insufficient_permissions") && !error.message.includes("oauth2client"),
);

const receipt = await tools.get("get_receipt")!.handler({ external_id: "waitrose-1" });
assert.deepEqual(calls.at(-1), { method: "GET", url: "https://monzo.test/transaction-receipts?external_id=waitrose-1", contentType: null, body: null });
assert.equal(receipt.structuredContent.receipt.id, "receipt_1");

await tools.get("delete_receipt")!.handler({ external_id: "waitrose-1" });
assert.deepEqual(calls.at(-1), { method: "DELETE", url: "https://monzo.test/transaction-receipts?external_id=waitrose-1", contentType: null, body: null });

failNetwork = true;
await assert.rejects(
  tools.get("register_webhook")!.handler({ account_id: "acc_1", url: "https://hooks.example/s3cret" }),
  /outcome may be unknown/,
);

console.log("✅ Monzo tool contract passed");
