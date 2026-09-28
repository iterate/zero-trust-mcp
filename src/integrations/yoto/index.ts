import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { sha256b64url } from "../../seal.js";
import type { Env, GrantResult, UserClientOAuthIntegration } from "../types.js";
import type { YotoRefreshCoordinator } from "./coordinator.js";
import { parseTokenResponse, YotoClient } from "./client.js";

export const YOTO_SCOPES = "family:library:view user:content:manage family:devices:view offline_access";

export interface YotoSession {
  accessToken: string;
  apiOrigin: string;
}

const grantSchema = z.object({
  connectionId: z.string().uuid(),
  generation: z.number().int().nonnegative(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
  accessToken: z.string().min(1),
  accessExpiresAt: z.number().finite(),
});
type YotoGrant = z.infer<typeof grantSchema>;

function coordinator(env: Env, connectionId: string) {
  return env.YOTO_REFRESH_COORDINATOR.get(
    env.YOTO_REFRESH_COORDINATOR.idFromName(connectionId),
  ) as DurableObjectStub<YotoRefreshCoordinator>;
}

function result(grant: YotoGrant, env: Env): GrantResult {
  return {
    session: {
      accessToken: grant.accessToken,
      apiOrigin: env.YOTO_API_ORIGIN ?? "https://api.yotoplay.com",
    } satisfies YotoSession,
    expiresInSeconds: Math.floor((grant.accessExpiresAt - Date.now()) / 1000),
    grant,
  };
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// These values become a single URL path component, never a path or query.
const resourceId = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/, "Use an ID returned by Yoto");
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const streamTrack = z.object({
  title: z.string().trim().min(1).max(200),
  url: z.url({ protocol: /^https$/ }).describe("Public HTTPS audio URL; the player streams it directly"),
  format: z.enum(["mp3", "aac"]).default("mp3"),
});

export const yoto: UserClientOAuthIntegration = {
  id: "yoto",
  name: "Yoto",
  kind: "user-client-oauth",
  fields: [
    { name: "client_id", label: "Yoto client ID", type: "text" },
    { name: "client_secret", label: "Yoto client secret", type: "password" },
  ],
  presentation: {
    setupDescription: "Connect your Yoto library and players using your own confidential developer client. You sign in on Yoto's website.",
    securitySummary: "Client credentials and Yoto tokens stay inside sealed artifacts held by your MCP client. This server does not persist them.",
    affiliationNotice: "Independent software. Not affiliated with or endorsed by Yoto.",
    setupGuide: {
      title: "Yoto setup",
      description: "Create a confidential application, then keep its client ID and secret for reconnects.",
      actionLabel: "Open Yoto developer portal",
      actionUrl: "https://dashboard.yoto.dev/",
      steps: [
        {
          title: "Create a confidential client",
          description: "Use a confidential (server-side) application with these settings. Enable the listed permissions and refresh-token access.",
          settings: [
            { label: "Callback URL", value: "{origin}/{id}/callback", copy: true },
            { label: "Client type", value: "Confidential" },
            { label: "Scopes", value: YOTO_SCOPES, copy: true },
          ],
        },
        {
          title: "Connect and sign in",
          description: "Add the MCP endpoint, enter your developer client ID and secret, then sign in and consent on Yoto. Your Yoto password is entered only on Yoto's site.",
        },
      ],
    },
  },

  authorizeUrl(callbackUrl, state, credentials, env) {
    const url = new URL("/authorize", env.YOTO_AUTH_ORIGIN ?? "https://login.yotoplay.com");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: credentials.client_id,
      redirect_uri: callbackUrl,
      audience: "https://api.yotoplay.com",
      scope: YOTO_SCOPES,
      state,
    }).toString();
    return url.toString();
  },

  async exchangeCode(code, callbackUrl, credentials, env) {
    if (!credentials.client_id || !credentials.client_secret) throw new Error("Yoto client ID and secret are required");
    const response = await fetch(`${env.YOTO_AUTH_ORIGIN ?? "https://login.yotoplay.com"}/oauth/token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        redirect_uri: callbackUrl,
        code,
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Yoto token exchange rejected (${response.status})`);
    const token = await parseTokenResponse(response);
    const grant: YotoGrant = {
      connectionId: crypto.randomUUID(),
      generation: 0,
      clientId: credentials.client_id,
      clientSecret: credentials.client_secret,
      refreshToken: token.refresh_token,
      accessToken: token.access_token,
      accessExpiresAt: Date.now() + token.expires_in * 1000,
    };
    await coordinator(env, grant.connectionId).initialize({
      generation: 0,
      refreshHash: await sha256b64url(grant.refreshToken),
    });
    return result(grant, env);
  },

  async refreshGrant(value, env) {
    const parsed = grantSchema.safeParse(value);
    if (!parsed.success) throw new Error("Invalid Yoto grant");
    const grant = parsed.data;
    // MCP tokens expire sooner than some upstream tokens. Avoid unnecessary rotation.
    if (grant.accessExpiresAt > Date.now() + 60_000) return result(grant, env);
    const rotated = await coordinator(env, grant.connectionId).rotate({
      generation: grant.generation,
      refreshHash: await sha256b64url(grant.refreshToken),
      refreshToken: grant.refreshToken,
      clientId: grant.clientId,
      clientSecret: grant.clientSecret,
    });
    return result({
      ...grant,
      generation: grant.generation + 1,
      refreshToken: rotated.refreshToken,
      accessToken: rotated.accessToken,
      accessExpiresAt: Date.now() + rotated.expiresInSeconds * 1000,
    }, env);
  },

  registerTools(server: McpServer, session: unknown) {
    const { accessToken, apiOrigin } = session as YotoSession;
    const client = new YotoClient(accessToken, apiOrigin);
    server.registerTool("list_players", {
      description: "List Yoto players in your family, including their device IDs, names and online flags. Does not provide live battery or playback status.",
      annotations: readOnly,
    }, async () => json(await client.request("/device-v2/devices/mine")));

    server.registerTool("list_myo_cards", {
      description: "List your Yoto Make Your Own (MYO) cards. Use get_card for chapters and tracks; purchased cards are not included in this list.",
      annotations: readOnly,
    }, async () => json(await client.request("/content/mine")));

    server.registerTool("get_card", {
      description: "Get accessible Yoto content, including its chapters and tracks, by card ID.",
      inputSchema: z.object({ cardId: resourceId }),
      annotations: readOnly,
    }, async ({ cardId }) => json(await client.request(`/content/${encodeURIComponent(cardId)}`)));

    server.registerTool("list_library_groups", {
      description: "List your family's Yoto library groups and their card references. This is a list of groups, not the complete ungrouped library.",
      annotations: readOnly,
    }, async () => json(await client.request("/card/family/library/groups")));

    server.registerTool("get_library_group", {
      description: "Get a Yoto family library group and the available cards it contains.",
      inputSchema: z.object({ groupId: resourceId }),
      annotations: readOnly,
    }, async ({ groupId }) => json(await client.request(`/card/family/library/groups/${encodeURIComponent(groupId)}`)));

    server.registerTool("create_streaming_card", {
      description: "Create a new Yoto MYO playlist from public HTTPS MP3/AAC audio URLs, with one chapter per track. Requires internet during playback. Does not upload local files or link a physical MYO card; link it in the Yoto app. Retrying creates another playlist.",
      inputSchema: z.object({
        title: z.string().trim().min(1).max(200),
        description: z.string().max(2000).optional(),
        tracks: z.array(streamTrack).min(1).max(100),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async ({ title, description, tracks }) => json(await client.request("/content", {
      title,
      ...(description === undefined ? {} : { metadata: { description } }),
      content: {
        chapters: tracks.map((track, index) => ({
          key: String(index + 1).padStart(2, "0"),
          title: track.title,
          overlayLabel: String(index + 1),
          tracks: [{ key: "01", title: track.title, trackUrl: track.url, type: "stream", format: track.format }],
        })),
      },
    })));
  },
};
