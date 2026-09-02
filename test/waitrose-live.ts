import { strict as assert } from "node:assert";
import type { McpServer } from "@modelcontextprotocol/server";
import WaitroseClient from "waitrose";
import { waitrose } from "../src/integrations/waitrose/index.js";

const username = process.env.WAITROSE_USERNAME;
const password = process.env.WAITROSE_PASSWORD;
assert(username, "WAITROSE_USERNAME is required");
assert(password, "WAITROSE_PASSWORD is required");

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string }>;
}>;

const handlers = new Map<string, ToolHandler>();
const server = {
  registerTool(name: string, ...definitionAndHandler: unknown[]) {
    handlers.set(name, definitionAndHandler.at(-1) as ToolHandler);
  },
} as unknown as McpServer;

const client = new WaitroseClient();
const session = await client.login(username, password);
waitrose.registerTools(server, session);

const listOrders = handlers.get("get_orders");
const getOrder = handlers.get("get_order");
assert(listOrders, "get_orders is registered");
assert(getOrder, "get_order is registered");

const ordersResult = await listOrders({ limit: 1 });
const orders = JSON.parse(ordersResult.content[0]?.text ?? "null") as {
  previous: Array<{ id: string }>;
};
assert(orders.previous.length > 0, "a previous order is available for the live proof");

const orderResult = await getOrder({ orderId: orders.previous[0]!.id });
const order = JSON.parse(orderResult.content[0]?.text ?? "null") as {
  items: Array<{ name: string | null }>;
};
assert(order.items.length > 0, "get_order returns historical order items");
assert(order.items.every((item) => item.name), "every historical order item has a product name");

console.log(`waitrose MCP live proof: ${order.items.length} named historical items`);
