import { strict as assert } from "node:assert";
import type { McpServer } from "@modelcontextprotocol/server";
import { waitrose, type WaitroseSession } from "../src/integrations/waitrose/index.js";

const toolNames: string[] = [];
const server = {
  registerTool(name: string) {
    toolNames.push(name);
  },
} as unknown as McpServer;

const inertSession = {
  accessToken: "test-access-token",
  customerId: "test-customer",
  customerOrderId: "test-order",
  defaultBranchId: "test-branch",
} satisfies WaitroseSession;

waitrose.registerTools(server, inertSession);

assert(toolNames.includes("get_order"), "exposes historical order details through get_order");

console.log("waitrose MCP tool surface: ok");
