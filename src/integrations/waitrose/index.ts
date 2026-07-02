import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Env, GrantResult, PasswordIntegration } from "../types.js";
import WaitroseClient from "./client.js";

export interface WaitroseSession {
  accessToken: string;
  customerId: string;
  customerOrderId: string;
  defaultBranchId: string;
}

/** Rehydrate a client from a sealed session without re-logging-in. */
function clientFromSession(session: WaitroseSession): WaitroseClient {
  const client = new WaitroseClient();
  // Fields are TS-private only; this mirrors what the waitrose CLI does.
  Object.assign(client as unknown as Record<string, unknown>, {
    accessToken: session.accessToken,
    customerId: session.customerId,
    customerOrderId: session.customerOrderId,
    defaultBranchId: session.defaultBranchId,
  });
  return client;
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

async function login(creds: Record<string, string>): Promise<GrantResult> {
  const client = new WaitroseClient();
  const session = await client.login(creds.username, creds.password);
  return {
    session: {
      accessToken: session.accessToken,
      customerId: session.customerId,
      customerOrderId: session.customerOrderId,
      defaultBranchId: session.defaultBranchId,
    } satisfies WaitroseSession,
    expiresInSeconds: session.expiresIn,
    // Waitrose has no working token refresh — the durable grant IS the credentials.
    grant: creds,
  };
}

export const waitrose: PasswordIntegration = {
  id: "waitrose",
  name: "Waitrose",
  kind: "password",
  fields: [
    { name: "username", label: "Email", type: "email" },
    { name: "password", label: "Password", type: "password" },
  ],

  login: (creds: Record<string, string>, _env: Env) => login(creds),
  refreshGrant: (grant: unknown, _env: Env) => login(grant as Record<string, string>),

  registerTools(server: McpServer, session: unknown) {
    const client = clientFromSession(session as WaitroseSession);

    server.registerTool(
      "waitrose_search_products",
      {
        description: "Search the Waitrose product catalogue by text query. Returns product names, prices and line numbers (use line numbers with waitrose_add_to_trolley).",
        inputSchema: z.object({
          query: z.string().describe("Search term, e.g. 'organic milk'"),
          size: z.number().int().min(1).max(48).optional().describe("Max results (default 10)"),
        }),
      },
      async ({ query, size }) => {
        const results = await client.searchProducts(query, { size: size ?? 10 });
        return json({
          totalMatches: results.totalMatches,
          products: results.products.map((p) => ({
            lineNumber: p.lineNumber,
            name: p.name,
            brand: p.brandName,
            price: p.displayPrice,
            size: p.size,
            offer: p.promotions?.[0]?.promotionDescription,
          })),
        });
      },
    );

    server.registerTool(
      "waitrose_get_trolley",
      { description: "Get the current Waitrose trolley (shopping cart): items, quantities and totals." },
      async () => {
        const t = await client.getTrolley();
        const productsByLine = new Map(t.products.map((p) => [p.lineNumber, p]));
        return json({
          items: t.trolley.trolleyItems.map((item) => ({
            lineNumber: item.lineNumber,
            name: productsByLine.get(item.lineNumber)?.name,
            quantity: item.quantity,
            totalPrice: item.totalPrice,
          })),
          totals: t.trolley.trolleyTotals,
        });
      },
    );

    server.registerTool(
      "waitrose_add_to_trolley",
      {
        description: "Add a product to the Waitrose trolley by line number (find line numbers via waitrose_search_products).",
        inputSchema: z.object({
          lineNumber: z.string().describe("Product line number"),
          quantity: z.number().int().min(1).max(99).optional().describe("Quantity (default 1)"),
        }),
      },
      async ({ lineNumber, quantity }) => {
        const t = await client.addToTrolley(lineNumber, quantity ?? 1);
        return json({
          ok: !t.failures?.length,
          failures: t.failures,
          itemCount: t.trolley.trolleyItems.length,
          totalEstimatedCost: t.trolley.trolleyTotals.totalEstimatedCost,
        });
      },
    );

    server.registerTool(
      "waitrose_remove_from_trolley",
      {
        description: "Remove a product from the Waitrose trolley by line number.",
        inputSchema: z.object({ lineNumber: z.string() }),
      },
      async ({ lineNumber }) => {
        const t = await client.removeFromTrolley(lineNumber);
        return json({
          ok: !t.failures?.length,
          failures: t.failures,
          itemCount: t.trolley.trolleyItems.length,
        });
      },
    );

    server.registerTool(
      "waitrose_get_orders",
      { description: "List pending and previous Waitrose orders." },
      async () => {
        const { pending, previous } = await client.getOrders(5);
        const brief = (orders: typeof pending) =>
          orders.map((o) => ({
            id: o.customerOrderId,
            status: o.status,
            total: o.totals?.estimated?.totalPrice,
            slot: o.slots?.[0] && { type: o.slots[0].type, start: o.slots[0].startDateTime },
          }));
        return json({ pending: brief(pending), previous: brief(previous) });
      },
    );

    server.registerTool(
      "waitrose_get_account_info",
      { description: "Get the logged-in Waitrose account profile (email, address, memberships)." },
      async () => {
        const { profile, memberships } = await client.getAccountInfo();
        return json({ email: profile.email, address: profile.contactAddress, memberships });
      },
    );
  },
};
