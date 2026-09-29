import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { sha256b64url } from "../../seal.js";
import type { Env, GrantResult, UserClientOAuthIntegration } from "../types.js";
import type { MonzoRefreshCoordinator, MonzoRotationResult } from "./coordinator.js";
import { MonzoApiError, MonzoClient } from "./client.js";

// The current Monzo wordmark, copied verbatim from Monzo's official press site.
const MONZO_LOGO = `<svg width="138" height="24" viewBox="0 0 138 24" fill="none" role="img" aria-label="Monzo">
  <path d="M0.0789831 23.3769V0.626117H6.24562V3.66757C7.66062 1.33063 9.73947 0.196533 12.5345 0.196533C15.3296 0.196533 17.4434 1.38218 18.9457 3.8394C21.3565 1.34782 23.2082 0.196533 26.0906 0.196533C31.2965 0.196533 34.2313 3.08334 34.2313 8.37581V23.3769H27.593V11.0564C27.593 7.87749 26.9117 6.43409 24.3612 6.43409C21.8107 6.43409 20.3957 7.99778 20.3957 11.0564V23.3769H13.7224V11.0564C13.7224 7.87749 13.0412 6.43409 10.4906 6.43409C7.94014 6.43409 6.52513 7.99778 6.52513 11.0564V23.3769H0.0615234H0.0789831Z" fill="currentColor"/>
  <path d="M42.0932 3.59852C44.4166 1.31313 47.4737 0.0415649 50.6182 0.0415649C53.9723 0.0415649 56.8547 1.19285 59.1956 3.34077C61.6587 5.62616 62.9864 8.77071 62.9864 11.8465C62.9864 15.2832 61.816 18.1185 59.4926 20.4038C57.1167 22.7408 54.1994 23.9608 50.7056 23.9608C47.2117 23.9608 44.3293 22.7751 41.9709 20.3179C39.7349 18.0325 38.5645 15.1114 38.5645 11.9324C38.5645 8.75353 39.8048 5.83236 42.0932 3.58134V3.59852ZM50.7405 17.6201C53.7627 17.6201 56.2084 15.1286 56.2084 12.0355C56.2084 8.94254 53.7452 6.39941 50.7405 6.39941C47.7358 6.39941 45.2726 8.89099 45.2726 12.0355C45.2726 15.1801 47.7707 17.6201 50.7405 17.6201Z" fill="currentColor"/>
  <path d="M67.3008 23.3768V0.625995H73.7644L73.6771 3.66745C75.0921 1.38206 77.2582 0.196411 80.3153 0.196411C85.1019 0.196411 88.194 3.16913 88.194 8.37569V23.3768H81.3985V11.0563C81.3985 7.87737 80.7171 6.43397 78.0793 6.43397C75.4414 6.43397 73.9915 7.99765 73.9915 11.0563V23.3768H67.3183H67.3008Z" fill="currentColor"/>
  <path d="M117.053 3.59852C119.377 1.31313 122.434 0.0415649 125.578 0.0415649C128.932 0.0415649 131.815 1.19285 134.156 3.34077C136.619 5.62616 137.946 8.77071 137.946 11.8465C137.946 15.2832 136.776 18.1185 134.453 20.4038C132.077 22.7408 129.159 23.9608 125.666 23.9608C122.172 23.9608 119.289 22.7751 116.931 20.3179C114.695 18.0325 113.524 15.1114 113.524 11.9324C113.524 8.75353 114.765 5.83236 117.053 3.58134V3.59852ZM125.7 17.6201C128.723 17.6201 131.168 15.1286 131.168 12.0355C131.168 8.94254 128.705 6.39941 125.7 6.39941C122.696 6.39941 120.233 8.89099 120.233 12.0355C120.233 15.1801 122.731 17.6201 125.7 17.6201Z" fill="currentColor"/>
  <path d="M93.1387 23.3768V18.6342L102.659 6.51993H93.1387V0.626038H110.328V6.00443L101.926 17.4829H110.503V23.3768H93.1561H93.1387Z" fill="currentColor"/>
</svg>`;

interface MonzoSession {
  accessToken: string;
  userId: string;
  apiOrigin: string;
}

interface MonzoGrant {
  connectionId: string;
  generation: number;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
  accessExpiresAt: number;
  userId: string;
}

interface MonzoWebhook {
  id: string;
  account_id: string;
  url: string;
}

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

const minorUnits = z.number().int();
const receiptSubItem = z.object({
  description: z.string().min(1).max(500),
  amount: minorUnits.describe("Line total in minor units; negative for discounts"),
  quantity: z.number().positive().default(1),
  unit: z.string().max(20).default("").describe("e.g. kg; empty for countable items"),
  tax: minorUnits.default(0).describe("Tax included in this line, in minor units"),
});
// Monzo stores receipts with missing tax fields or nulls but then cannot read
// or delete them, so every optional field has a concrete default.
const receiptSchema = z.object({
  transaction_id: z.string().min(1),
  external_id: z.string().min(1).max(200).describe("Your stable key, e.g. waitrose-<order ID>; saving again with it replaces the receipt"),
  total: minorUnits.positive().describe("The transaction amount as positive minor units"),
  currency: z.string().regex(/^[A-Z]{3}$/).default("GBP").describe("ISO 4217 code, applied to every line"),
  items: z.array(receiptSubItem.extend({ sub_items: z.array(receiptSubItem).max(50).default([]) })).min(1).max(500),
  taxes: z.array(z.object({
    description: z.string().min(1).max(100),
    amount: minorUnits,
    tax_number: z.string().max(50).optional(),
  })).max(20).default([]).describe("Only tax added on top of item amounts; UK VAT is usually already included"),
  payments: z.array(z.object({
    type: z.enum(["card", "cash", "gift_card"]),
    amount: minorUnits,
    last_four: z.string().regex(/^\d{4}$/).optional(),
    gift_card_type: z.string().max(100).optional(),
  })).max(20).default([]),
  merchant: z.object({
    name: z.string().max(200).optional(),
    online: z.boolean().optional(),
    phone: z.string().max(50).optional(),
    email: z.string().max(200).optional(),
    store_name: z.string().max(200).optional(),
    store_address: z.string().max(500).optional(),
    store_postcode: z.string().max(20).optional(),
  }).default({}),
});

/** Monzo's documented totals rules, reported rather than enforced. */
function receiptWarnings(receipt: z.infer<typeof receiptSchema>): string[] {
  const sum = (lines: Array<{ amount: number }>) => lines.reduce((total, line) => total + line.amount, 0);
  const warnings: string[] = [];
  const itemsAndTaxes = sum(receipt.items) + sum(receipt.taxes);
  if (itemsAndTaxes !== receipt.total) warnings.push(`Items plus taxes sum to ${itemsAndTaxes}, not the total ${receipt.total}`);
  if (receipt.payments.length && sum(receipt.payments) !== receipt.total) {
    warnings.push(`Payments sum to ${sum(receipt.payments)}, not the total ${receipt.total}`);
  }
  for (const item of receipt.items) {
    if (item.sub_items.length && sum(item.sub_items) !== item.amount) {
      warnings.push(`Sub-items of "${item.description}" sum to ${sum(item.sub_items)}, not its amount ${item.amount}`);
    }
  }
  return warnings;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user_id?: string;
}

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function apiOrigin(env: Env) {
  return env.MONZO_API_ORIGIN ?? "https://api.monzo.com";
}

function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount / 100);
  } catch {
    return `${amount} ${currency} minor units`;
  }
}

function assertGrant(value: unknown): MonzoGrant {
  const grant = value as Partial<MonzoGrant>;
  if (
    !grant ||
    typeof grant.connectionId !== "string" ||
    typeof grant.generation !== "number" ||
    typeof grant.clientId !== "string" ||
    typeof grant.clientSecret !== "string" ||
    typeof grant.refreshToken !== "string" ||
    typeof grant.accessToken !== "string" ||
    typeof grant.accessExpiresAt !== "number" ||
    typeof grant.userId !== "string"
  ) {
    throw new Error("invalid_monzo_grant");
  }
  return grant as MonzoGrant;
}

async function exchangeCode(
  code: string,
  callbackUrl: string,
  credentials: Record<string, string>,
  env: Env,
): Promise<GrantResult> {
  const clientId = credentials.client_id;
  const clientSecret = credentials.client_secret;
  if (!clientId || !clientSecret) throw new Error("Monzo client ID and secret are required");

  const response = await fetch(`${apiOrigin(env)}/oauth2/token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: callbackUrl,
      code,
    }),
  });
  if (!response.ok) throw new Error(`Monzo token exchange rejected (${response.status})`);

  const token = (await response.json()) as TokenResponse;
  if (!token.access_token || !token.refresh_token || !token.expires_in || !token.user_id) {
    throw new Error("Monzo did not return a refresh token; check that the client is Confidential");
  }

  const connectionId = crypto.randomUUID();
  const generation = 0;
  const stub = env.MONZO_REFRESH_COORDINATOR.get(
    env.MONZO_REFRESH_COORDINATOR.idFromName(connectionId),
  ) as DurableObjectStub<MonzoRefreshCoordinator>;
  await stub.initialize({
    generation,
    refreshHash: await sha256b64url(token.refresh_token),
  });

  return {
    session: {
      accessToken: token.access_token,
      userId: token.user_id,
      apiOrigin: apiOrigin(env),
    } satisfies MonzoSession,
    expiresInSeconds: token.expires_in,
    grant: {
      connectionId,
      generation,
      clientId,
      clientSecret,
      refreshToken: token.refresh_token,
      accessToken: token.access_token,
      accessExpiresAt: Date.now() + token.expires_in * 1000,
      userId: token.user_id,
    } satisfies MonzoGrant,
  };
}

async function refreshGrant(value: unknown, env: Env): Promise<GrantResult> {
  const grant = assertGrant(value);
  // MCP access tokens are capped at one hour, while Monzo access tokens are
  // commonly longer lived. Re-wrap a still-valid upstream session without
  // rotating Monzo's single-use refresh token.
  if (grant.accessExpiresAt > Date.now() + 60_000) {
    return {
      session: {
        accessToken: grant.accessToken,
        userId: grant.userId,
        apiOrigin: apiOrigin(env),
      } satisfies MonzoSession,
      expiresInSeconds: Math.floor((grant.accessExpiresAt - Date.now()) / 1000),
      grant,
    };
  }

  const stub = env.MONZO_REFRESH_COORDINATOR.get(
    env.MONZO_REFRESH_COORDINATOR.idFromName(grant.connectionId),
  ) as DurableObjectStub<MonzoRefreshCoordinator>;
  const rotated = (await stub.rotate({
    generation: grant.generation,
    refreshHash: await sha256b64url(grant.refreshToken),
    refreshToken: grant.refreshToken,
    clientId: grant.clientId,
    clientSecret: grant.clientSecret,
    userId: grant.userId,
  })) as MonzoRotationResult;

  return {
    session: {
      accessToken: rotated.accessToken,
      userId: rotated.userId,
      apiOrigin: apiOrigin(env),
    } satisfies MonzoSession,
    expiresInSeconds: rotated.expiresInSeconds,
    grant: {
      ...grant,
      generation: grant.generation + 1,
      refreshToken: rotated.refreshToken,
      accessToken: rotated.accessToken,
      accessExpiresAt: Date.now() + rotated.expiresInSeconds * 1000,
      userId: rotated.userId,
    } satisfies MonzoGrant,
  };
}

export const monzo: UserClientOAuthIntegration = {
  id: "monzo",
  name: "Monzo",
  kind: "user-client-oauth",
  presentation: {
    logoSvg: MONZO_LOGO,
    productLabel: "Zero Trust MCP",
    setupDescription: "Enter the client ID and secret of your own confidential Monzo OAuth client. Monzo then asks you to approve access in its app.",
    securitySummary: "Nothing usable is stored here. Credentials and tokens remain inside sealed artifacts held by your browser and MCP client.",
    affiliationNotice: "Independent software. Not affiliated with or endorsed by Monzo Bank Limited.",
    setupGuide: {
      title: "Create a Monzo OAuth client",
      description: "Do this once, then reuse the client ID and secret when you reconnect. Monzo's [authentication docs](https://docs.monzo.com/#authentication) explain the flow.",
      actionLabel: "Open Monzo developer portal",
      actionUrl: "https://developers.monzo.com/",
      steps: [
        {
          title: "Sign in to the developer portal",
          description: "Open [developers.monzo.com](https://developers.monzo.com/) and choose **Sign in with your Monzo account**. Monzo emails you a sign-in link. You may also need to approve the sign-in in the Monzo app.",
        },
        {
          title: "Create the client",
          description: "Go to **Clients**, then **New OAuth Client**. Enter these values and leave Logo URL and Description blank.\n\n**Confidential** is required. [Non-confidential clients](https://docs.monzo.com/#client-confidentiality) get no refresh token, so the connection would stop working after a few hours.",
          settings: [
            { label: "Name", value: "Zero Trust MCP", copy: true },
            { label: "Redirect URL", value: "{origin}/{id}/callback", copy: true },
            { label: "Confidentiality", value: "Confidential" },
          ],
        },
        {
          title: "Copy the credentials",
          description: "Submit, then open the new client to find its **Client ID** and **Client secret**. Create a separate client for each MCP client: Monzo allows one active token per client, so a second connection signs out the first.",
        },
        {
          title: "Connect and approve",
          description: "Enter the ID and secret in the connection form. Monzo emails you a sign-in link, then asks you to approve access to your data in the Monzo app. The connection page waits until access works.",
        },
      ],
    },
    colors: {
      background: "#f2f4f3",
      ink: "#14233c",
      accent: "#ff5a5f",
      accentInk: "#14233c",
      subtle: "#edf8f7",
    },
  },
  connectionFlow: {
    instructionTitle: "Approve in the Monzo app",
    instructionDescription: "Monzo has authenticated you. Open the Monzo app and approve the pending developer access request; this page will keep checking securely.",
    pendingTitle: "Still waiting for Monzo",
    pendingDescription: "Open Monzo and look for “Login/Approval Request” or “Allow access to your data”. Once approved, this page will update automatically.",
    readyTitle: "Monzo is connected",
    readyDescription: "Account access is approved and Zero Trust MCP is ready to answer through your MCP client.",
    checkLabel: "I’ve approved — check again",
    returnLabel: "Return to your MCP client",
    async check(rawSession, env) {
      const session = rawSession as MonzoSession;
      try {
        await new MonzoClient(session.accessToken, session.apiOrigin ?? apiOrigin(env)).get("/accounts");
        return "ready";
      } catch (error) {
        if (error instanceof MonzoApiError && (error.status === 401 || error.status === 403)) return "pending";
        throw error;
      }
    },
  },
  fields: [
    { name: "client_id", label: "OAuth client ID", type: "text" },
    { name: "client_secret", label: "OAuth client secret", type: "password" },
  ],

  authorizeUrl(callbackUrl, state, credentials, env) {
    const url = new URL(env.MONZO_AUTH_ORIGIN ?? "https://auth.monzo.com/");
    url.searchParams.set("client_id", credentials.client_id);
    url.searchParams.set("redirect_uri", callbackUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    return url.toString();
  },

  exchangeCode,
  refreshGrant,

  registerTools(server: McpServer, rawSession: unknown) {
    const session = rawSession as MonzoSession;
    const client = new MonzoClient(session.accessToken, session.apiOrigin);

    server.registerTool(
      "whoami",
      { description: "Check whether Monzo approved this token and return the connected Monzo user ID." },
      async () => json(await client.get<Record<string, unknown>>("/ping/whoami")),
    );

    server.registerTool(
      "list_accounts",
      { description: "List the connected Monzo current, joint, and business accounts." },
      async () => {
        const result = await client.get<{ accounts: Array<Record<string, unknown>> }>("/accounts");
        return json({ accounts: result.accounts });
      },
    );

    server.registerTool(
      "get_balance",
      {
        description: "Get the live balance and spend-today amount for a Monzo account.",
        inputSchema: z.object({ account_id: z.string() }),
      },
      async ({ account_id }) => {
        const result = await client.get<{ balance: number; total_balance?: number; currency: string; spend_today: number }>(
          `/balance?${new URLSearchParams({ account_id })}`,
        );
        return json({
          ...result,
          balance_formatted: formatAmount(result.balance, result.currency),
          spend_today_formatted: formatAmount(result.spend_today, result.currency),
        });
      },
    );

    server.registerTool(
      "list_pots",
      {
        description: "List pots for a Monzo current account, including balances and goals.",
        inputSchema: z.object({ current_account_id: z.string() }),
      },
      async ({ current_account_id }) => {
        const result = await client.get<{ pots: Array<Record<string, unknown>> }>(
          `/pots?${new URLSearchParams({ current_account_id })}`,
        );
        return json(result);
      },
    );

    server.registerTool(
      "list_transactions",
      {
        description: "List up to 50 live Monzo transactions. After the initial five-minute authorization window, Monzo generally limits API history to 90 days.",
        inputSchema: z.object({
          account_id: z.string(),
          since: z.string().optional().describe("RFC3339 timestamp or transaction ID"),
          before: z.string().optional().describe("RFC3339 timestamp"),
          limit: z.number().int().min(1).max(50).default(20),
        }),
      },
      async ({ account_id, since, before, limit }) => {
        const params = new URLSearchParams({ account_id, limit: String(limit) });
        params.append("expand[]", "merchant");
        if (since) params.set("since", since);
        if (before) params.set("before", before);
        const result = await client.get<{ transactions: Array<Record<string, any>> }>(`/transactions?${params}`);
        return json({
          transactions: result.transactions.map((transaction) => ({
            id: transaction.id,
            account_id: transaction.account_id,
            created: transaction.created,
            settled: transaction.settled,
            amount: transaction.amount,
            currency: transaction.currency,
            formatted: formatAmount(transaction.amount, transaction.currency),
            description: transaction.description,
            merchant: typeof transaction.merchant === "object" ? transaction.merchant?.name : transaction.merchant,
            category: transaction.category,
            decline_reason: transaction.decline_reason || undefined,
            is_load: Boolean(transaction.is_load),
          })),
        });
      },
    );

    server.registerTool(
      "get_transaction",
      {
        description: "Get one Monzo transaction by ID with full merchant details, notes, metadata and settlement state. Use IDs from list_transactions or webhook events.",
        inputSchema: z.object({ transaction_id: z.string().min(1) }),
        annotations: readOnly,
      },
      async ({ transaction_id }) => {
        const params = new URLSearchParams([["expand[]", "merchant"]]);
        const { transaction } = await client.get<{ transaction: Record<string, any> }>(
          `/transactions/${encodeURIComponent(transaction_id)}?${params}`,
        );
        return json({ transaction: { ...transaction, formatted: formatAmount(transaction.amount, transaction.currency) } });
      },
    );

    server.registerTool(
      "list_webhooks",
      {
        description: "List the webhooks this Monzo OAuth client has registered on an account. Webhooks registered by other clients are not visible.",
        inputSchema: z.object({ account_id: z.string() }),
        annotations: readOnly,
      },
      async ({ account_id }) => {
        const result = await client.get<{ webhooks: MonzoWebhook[] }>(`/webhooks?${new URLSearchParams({ account_id })}`);
        return json(result);
      },
    );

    server.registerTool(
      "register_webhook",
      {
        description: "Register an HTTPS URL to receive Monzo's transaction.created events for an account. Monzo POSTs each new transaction, including amount, description and merchant details, as JSON {type, data}, retrying failed deliveries up to 5 times. Only use a receiver URL the user explicitly provided: it will receive their financial data. Monzo does not sign payloads, so the URL should contain an unguessable secret. Monzo does not document deduplicating registrations; check list_webhooks first.",
        inputSchema: z.object({
          account_id: z.string(),
          url: z.url({ protocol: /^https$/ }).describe("HTTPS receiver URL, ideally with an unguessable secret path or query"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ account_id, url }) => {
        const result = await client.request<{ webhook: MonzoWebhook }>("POST", "/webhooks", new URLSearchParams({ account_id, url }));
        return json(result);
      },
    );

    server.registerTool(
      "delete_webhook",
      {
        description: "Delete a Monzo webhook by ID so Monzo stops sending notifications to it. Use list_webhooks for IDs.",
        inputSchema: z.object({ webhook_id: z.string().min(1) }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ webhook_id }) => {
        await client.request("DELETE", `/webhooks/${encodeURIComponent(webhook_id)}`);
        return json({ deleted: webhook_id });
      },
    );

    server.registerTool(
      "create_receipt",
      {
        description: "Attach an itemised receipt to a Monzo transaction the user made; it appears on the transaction in the Monzo app. Saving again with the same external_id replaces that receipt. Amounts are integer minor units (pence). Item amounts are line totals and, plus any taxes, should sum to total; use negative items for discounts. For a Waitrose order, use get_order line totals and add an adjustment item if the card charge differs. Returns warnings when totals do not add up.",
        inputSchema: receiptSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async (receipt) => {
        const { currency } = receipt;
        const line = <T extends object>(value: T) => ({ ...value, currency });
        const result = await client.request<{ receipt_id?: string } | undefined>("PUT", "/transaction-receipts", {
          ...receipt,
          items: receipt.items.map(({ sub_items, ...item }) => ({ ...line(item), sub_items: sub_items.map(line) })),
          taxes: receipt.taxes.map(line),
          payments: receipt.payments.map(line),
        });
        return json({
          saved: true,
          external_id: receipt.external_id,
          transaction_id: receipt.transaction_id,
          receipt_id: result?.receipt_id,
          warnings: receiptWarnings(receipt),
        });
      },
    );

    server.registerTool(
      "get_receipt",
      {
        description: "Get a receipt this Monzo OAuth client created, by its external_id.",
        inputSchema: z.object({ external_id: z.string().min(1).max(200) }),
        annotations: readOnly,
      },
      async ({ external_id }) => json(await client.get(`/transaction-receipts?${new URLSearchParams({ external_id })}`)),
    );

    server.registerTool(
      "delete_receipt",
      {
        description: "Delete a receipt this Monzo OAuth client created, by its external_id.",
        inputSchema: z.object({ external_id: z.string().min(1).max(200) }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ external_id }) => {
        await client.request("DELETE", `/transaction-receipts?${new URLSearchParams({ external_id })}`);
        return json({ deleted: external_id });
      },
    );
  },
};
