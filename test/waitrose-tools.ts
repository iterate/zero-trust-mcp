import { strict as assert } from "node:assert";
import type { McpServer } from "@modelcontextprotocol/server";
import { waitrose, type WaitroseSession } from "../src/integrations/waitrose/index.js";

const tools = new Map<string, { config: any; handler: (args: any) => Promise<any> }>();
const server = {
  registerTool(name: string, config: any, handler: (args: any) => Promise<any>) {
    tools.set(name, { config, handler });
  },
} as unknown as McpServer;

waitrose.registerTools(server, {
  accessToken: "test-access-token", customerId: "test-customer",
  customerOrderId: "stale-order", defaultBranchId: "test-branch",
} satisfies WaitroseSession);

assert.equal(tools.size, 13);
assert(tools.has("get_order"));
assert.equal(tools.get("get_checkout")!.config.annotations.readOnlyHint, true);
assert.equal(tools.get("place_order")!.config.annotations.destructiveHint, true);
assert.equal(tools.get("place_order")!.config.annotations.idempotentHint, false);

const calls: { url: string; body: any }[] = [];
let total = 50;
let eligibility = "ALLOWED";
let placeStatus = 200;
const oldFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = String(input);
  const body = JSON.parse(init?.body as string);
  calls.push({ url, body });
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-access-token");
  if (url.endsWith("/place")) {
    assert.equal(init?.redirect, "manual");
    assert.deepEqual(body, { instantCheckout: true, event: "PLACE" });
    if (placeStatus !== 200) return new Response("secret provider body", { status: placeStatus });
    return Response.json({ customerOrderId: "current-order", totals: { estimated: {}, actual: null }, slots: [] });
  }
  const query = body.query as string;
  if (query.startsWith("query GetShoppingContext")) return Response.json({ data: { shoppingContext: { customerOrderId: "current-order", defaultBranchId: "branch" } } });
  if (query.startsWith("query CurrentSlot")) {
    assert.equal(body.variables.input.customerOrderId, "current-order");
    return Response.json({ data: { currentSlot: { slotType: "DELIVERY", startDateTime: "2030-01-01T10:00:00Z", endDateTime: "2030-01-01T11:00:00Z" } } });
  }
  if (query.startsWith("query GetTrolley")) {
    assert.equal(body.variables.orderId, "current-order");
    return Response.json({ data: { getTrolley: {
      instantCheckout: eligibility, checkoutReadiness: { slotTypeValid: true }, products: [], failures: [],
      trolley: { orderId: "current-order", trolleyItems: [{ lineNumber: "milk", quantity: { amount: 1 } }], trolleyTotals: {
        totalEstimatedCost: { amount: total, currencyCode: "GBP" }, minimumSpendThresholdMet: true, trolleyItemCounts: { hardConflicts: 0 },
      } },
    } } });
  }
  if (query.startsWith("query SlotDates")) {
    assert.deepEqual(body.variables.slotDatesInput, { slotType: "DELIVERY", branchId: "branch", customerOrderId: "current-order", addressId: "address" });
    return Response.json({ data: { slotDates: { content: [{ id: "2030-01-01" }], failures: [] } } });
  }
  if (query.startsWith("query SlotDays")) {
    assert.equal(body.variables.slotDaysInput.customerOrderId, "current-order");
    assert.equal(body.variables.slotDaysInput.fromDate, "2030-01-01");
    return Response.json({ data: { slotDays: { content: [{ slots: [{ id: "slot" }] }], failures: [] } } });
  }
  if (query.startsWith("mutation BookSlot")) {
    assert.deepEqual(body.variables.input, { slotId: "slot", slotType: "DELIVERY", addressId: "address" });
    return Response.json({ data: { bookSlot: { slotExpiryDateTime: "2030-01-01T09:00:00Z", failures: [] } } });
  }
  throw new Error("Unexpected upstream request");
}) as typeof fetch;

async function call(name: string, args: any = {}) {
  const tool = tools.get(name)!;
  const parsed = tool.config.inputSchema?.parse(args) ?? args;
  return JSON.parse((await tool.handler(parsed)).content[0].text);
}
const placementCount = () => calls.filter(c => c.url.endsWith("/place")).length;
try {
  assert.equal((await call("get_current_slot")).slotType, "DELIVERY");
  assert.equal((await call("list_slot_dates", { slotType: "DELIVERY", addressId: "address" }))[0].id, "2030-01-01");
  assert.equal((await call("list_slots", { slotType: "DELIVERY", fromDate: "2030-01-01" }))[0].slots[0].id, "slot");
  await call("book_slot", { slotId: "slot", slotType: "DELIVERY", addressId: "address" });
  const review = await call("get_checkout");
  assert(review.canPlaceOrder);
  assert.equal(placementCount(), 0);
  const args = { orderId: review.orderId, expectedTotal: review.estimatedTotal };
  assert.equal((await call("place_order", args)).customerOrderId, "current-order");
  assert.equal(placementCount(), 1);
  total = 51;
  await assert.rejects(call("place_order", args), /total has changed/);
  assert.equal(placementCount(), 1);
  total = 50;
  eligibility = "NOT_ALLOWED";
  assert.equal((await call("get_checkout")).canPlaceOrder, false);
  await assert.rejects(call("place_order", args), /Checkout blocked/);
  assert.equal(placementCount(), 1);
  eligibility = "ALLOWED";
  placeStatus = 500;
  await assert.rejects(call("place_order", args), /outcome is unknown/);
  assert.equal(placementCount(), 2, "ambiguous payment outcome is not retried by MCP");
  await assert.rejects(call("place_order", { ...args, expectedTotal: { amount: -1, currencyCode: "GBP" } }));
  await assert.rejects(call("list_slots", { slotType: "DELIVERY", fromDate: "2030-99-99" }));
  assert.equal(placementCount(), 2);
  await call("get_trolley"); // sealed session still has stale-order; refresh before reads
  console.log("Waitrose: 13 tools, checkout/slot library wiring, fresh context, changed totals, blocked eligibility and no payment retries: ok");
} finally {
  globalThis.fetch = oldFetch;
}
