import type { McpServer } from "@modelcontextprotocol/server";
import type { Env, GrantResult, OAuthIntegration } from "../types.js";

interface DemoSession {
  accessToken: string;
  apiUrl: string;
}

interface DemoGrant {
  refreshToken: string;
}

async function tokensToResult(res: Response, env: Env, previous?: DemoGrant): Promise<GrantResult> {
  const t = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string };
  if (!res.ok || !t.access_token) throw new Error(`demo provider token grant failed: ${t.error ?? res.status}`);
  const refreshToken = t.refresh_token ?? previous?.refreshToken;
  if (!refreshToken) throw new Error("demo provider returned no refresh token");
  return {
    session: { accessToken: t.access_token, apiUrl: env.DEMO_PROVIDER_URL } satisfies DemoSession,
    expiresInSeconds: t.expires_in ?? 3600,
    // Providers may rotate the refresh token; adopt the new one if present.
    grant: { refreshToken } satisfies DemoGrant,
  };
}

export const demo: OAuthIntegration = {
  id: "demo",
  name: "Demo",
  kind: "oauth",
  presentation: {
    setupDescription: "A fake OAuth provider that shows the complete flow without asking for real credentials.",
    securitySummary: "The demo uses fake identity data and disposable OAuth tokens.",
    setupGuide: {
      title: "Try the demo",
      description: "No account or credentials required.",
      actionLabel: "Read the demo code",
      actionUrl: "https://github.com/iterate/zero-trust-mcp/tree/main/dummy-oauth",
      steps: [
        { title: "Add it", description: "Run one of the commands above." },
        { title: "Approve", description: "The browser opens a fake OAuth provider. Approve access." },
        { title: "Call it", description: "Ask the MCP client to run whoami. The request goes through the same sealed-token flow as a real integration." },
      ],
    },
  },

  authorizeUrl(callbackUrl, state, env) {
    const u = new URL(`${env.DEMO_PROVIDER_URL}/authorize`);
    u.searchParams.set("client_id", "zero-trust-mcp");
    u.searchParams.set("redirect_uri", callbackUrl);
    u.searchParams.set("state", state);
    return u.toString();
  },

  async exchangeCode(code, callbackUrl, env) {
    const res = await fetch(`${env.DEMO_PROVIDER_URL}/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: callbackUrl }),
    });
    return tokensToResult(res, env);
  },

  async refreshGrant(grant, env) {
    const g = grant as DemoGrant;
    const res = await fetch(`${env.DEMO_PROVIDER_URL}/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: g.refreshToken }),
    });
    return tokensToResult(res, env, g);
  },

  registerTools(server: McpServer, session: unknown) {
    const s = session as DemoSession;

    server.registerTool(
      "whoami",
      { description: "Get the authenticated profile from the dummy OAuth provider's API." },
      async () => {
        const res = await fetch(`${s.apiUrl}/api/me`, { headers: { Authorization: `Bearer ${s.accessToken}` } });
        const body = await res.text();
        if (!res.ok) throw new Error(`demo API error ${res.status}: ${body}`);
        return { content: [{ type: "text" as const, text: body }] };
      },
    );

  },
};
