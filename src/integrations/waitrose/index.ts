import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import WaitroseClient from "waitrose";
import type { Env, GrantResult, PasswordIntegration } from "../types.js";

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

/**
 * waitrose@1.2.1 adds the account's branch ID to catalogue searches, but the
 * current upstream API returns no results when that field is present. Keep the
 * authenticated catalogue client branchless until the package fix is released.
 */
function catalogClientFromSession(session: WaitroseSession): WaitroseClient {
  return clientFromSession({ ...session, defaultBranchId: "" });
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const slotType = z.enum(["DELIVERY", "COLLECTION"]);

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
  presentation: {
    affiliationNotice: "Independent software. Not affiliated with or endorsed by Waitrose & Partners.",
  },
  fields: [
    { name: "username", label: "Email", type: "email" },
    { name: "password", label: "Password", type: "password" },
  ],

  login: (creds: Record<string, string>, _env: Env) => login(creds),
  refreshGrant: (grant: unknown, _env: Env) => login(grant as Record<string, string>),

  registerTools(server: McpServer, session: unknown) {
    const waitroseSession = session as WaitroseSession;
    const client = clientFromSession(waitroseSession);
    const catalogClient = catalogClientFromSession(waitroseSession);

    server.registerTool(
      "search_products",
      {
        description: "Search the Waitrose product catalogue by text query. Returns product names, prices and line numbers (use line numbers with add_to_trolley).",
        inputSchema: z.object({
          query: z.string().describe("Search term, e.g. 'organic milk'"),
          size: z.number().int().min(1).max(48).optional().describe("Max results (default 10)"),
        }),
      },
      async ({ query, size }) => {
        const results = await catalogClient.searchProducts(query, { size: size ?? 10 });
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
      "get_trolley",
      { description: "Get the current Waitrose trolley (shopping cart): items, quantities and totals." },
      async () => {
        await client.getShoppingContext();
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
      "add_to_trolley",
      {
        description: "Add a product to the Waitrose trolley by line number (find line numbers via search_products).",
        inputSchema: z.object({
          lineNumber: z.string().describe("Product line number"),
          quantity: z.number().int().min(1).max(99).optional().describe("Quantity (default 1)"),
        }),
      },
      async ({ lineNumber, quantity }) => {
        await client.getShoppingContext();
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
      "remove_from_trolley",
      {
        description: "Remove a product from the Waitrose trolley by line number.",
        inputSchema: z.object({ lineNumber: z.string() }),
      },
      async ({ lineNumber }) => {
        await client.getShoppingContext();
        const t = await client.removeFromTrolley(lineNumber);
        return json({
          ok: !t.failures?.length,
          failures: t.failures,
          itemCount: t.trolley.trolleyItems.length,
        });
      },
    );

    server.registerTool(
      "get_orders",
      {
        description: "List pending and previous Waitrose orders. Use get_order with an order ID to retrieve its items.",
        inputSchema: z.object({
          limit: z.number().int().min(1).max(15).optional().describe("Max orders per category (default 5)"),
        }),
      },
      async ({ limit }) => {
        const { pending, previous } = await client.getOrders(limit ?? 5);
        const brief = (orders: typeof pending) =>
          orders.map((o) => ({
            id: o.customerOrderId,
            status: o.status,
            created: o.created,
            updated: o.lastUpdated,
            total: o.totals?.actual?.paid ?? o.totals?.estimated?.totalPrice,
            slot: o.slots?.[0] && { type: o.slots[0].type, start: o.slots[0].startDateTime },
          }));
        return json({ pending: brief(pending), previous: brief(previous) });
      },
    );

    server.registerTool(
      "get_order",
      {
        description: "Get a Waitrose order's full details, including product names, quantities and prices.",
        inputSchema: z.object({
          orderId: z.string().min(1).describe("Order ID returned by get_orders"),
        }),
      },
      async ({ orderId }) => {
        const order = await client.getOrder(orderId);
        const lineNumbers = [...new Set(order.orderLines.map((line) => line.lineNumber))];
        const products = await client.getProductsByLineNumbers(lineNumbers);
        const productsByLine = new Map(products.map((product) => [product.lineNumber, product]));

        return json({
          id: order.customerOrderId,
          status: order.status,
          created: order.created,
          updated: order.lastUpdated,
          slot: order.slots?.[0],
          items: order.orderLines.map((line) => ({
            lineNumber: line.lineNumber,
            name: productsByLine.get(line.lineNumber)?.name ?? null,
            status: line.orderLineStatus,
            quantity: line.quantity ?? line.estimatedQuantity,
            unitPrice: line.unitPrice ?? line.estimatedUnitPrice,
            totalPrice: line.totalPrice ?? line.estimatedTotalPrice,
            substitutionAllowed: line.substitutionAllowed,
          })),
          totals: order.totals,
        });
      },
    );

    server.registerTool("get_current_slot", {
      description: "Get the current Waitrose delivery or collection slot.",
      annotations: readOnly,
    }, async () => {
      await client.getShoppingContext();
      return json(await client.getCurrentSlot());
    });

    server.registerTool("list_slot_dates", {
      description: "List available Waitrose delivery or collection dates. Use the contact address ID from get_account_info for delivery, or a known branch ID for collection.",
      inputSchema: z.object({ slotType, branchId: z.string().min(1).optional(), addressId: z.string().min(1).optional() }),
      annotations: readOnly,
    }, async ({ slotType, branchId, addressId }) => {
      await client.getShoppingContext();
      return json(await client.getSlotDates(slotType, branchId, addressId));
    });

    server.registerTool("list_slots", {
      description: "Get available Waitrose slots from a date, including IDs, times and charges. Use slot IDs with book_slot.",
      inputSchema: z.object({ slotType, fromDate: z.iso.date(), branchId: z.string().min(1).optional(), addressId: z.string().min(1).optional() }),
      annotations: readOnly,
    }, async ({ slotType, fromDate, branchId, addressId }) => {
      await client.getShoppingContext();
      return json(await client.getSlotDays(slotType, fromDate, branchId, addressId));
    });

    server.registerTool("book_slot", {
      description: "Reserve a Waitrose delivery or collection slot. May replace the existing reservation. Does not place the order. Review checkout afterwards.",
      inputSchema: z.object({ slotId: z.string().min(1), slotType, addressId: z.string().min(1).optional() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async ({ slotId, slotType, addressId }) => {
      await client.getShoppingContext();
      return json(await client.bookSlot(slotId, slotType, addressId));
    });

    server.registerTool("get_checkout", {
      description: "Review the current Waitrose order, full trolley, slot, estimated total and instant-checkout eligibility. Read only. Resolve blockers before place_order; payment setup or challenges may require checkoutUrl.",
      annotations: readOnly,
    }, async () => json(await client.getCheckout()));

    server.registerTool("place_order", {
      description: "Place a reviewed Waitrose order using existing account payment setup. This commits a purchase: obtain user authorization for the reviewed trolley, slot and estimated total first. Supply the orderId and estimated total from get_checkout. Rechecks eligibility and totals, then submits once. If the outcome is unknown, inspect get_order before retrying. Totals remain estimates, not a price lock or settlement receipt.",
      inputSchema: z.object({
        orderId: z.string().min(1),
        expectedTotal: z.object({ amount: z.number().finite().nonnegative(), currencyCode: z.string().regex(/^[A-Z]{3}$/) }),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async ({ orderId, expectedTotal }) => json(await client.placeOrder({ orderId, expectedTotal })));

    server.registerTool(
      "get_account_info",
      { description: "Get the logged-in Waitrose account profile (email, address, memberships)." },
      async () => {
        const { profile, memberships } = await client.getAccountInfo();
        return json({ email: profile.email, address: profile.contactAddress, memberships });
      },
    );
  },
};
