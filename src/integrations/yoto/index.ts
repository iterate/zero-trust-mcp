import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { sha256b64url } from "../../seal.js";
import type { Env, GrantResult, UserClientOAuthIntegration } from "../types.js";
import type { YotoRefreshCoordinator } from "./coordinator.js";
import { registerAuthoringTools } from "./authoring-tools.js";
import { parseTokenResponse, YotoClient } from "./client.js";

export const YOTO_SCOPES = "family:library:view user:content:manage family:devices:view family:devices:control family:devices:manage offline_access";

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
const playerWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
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
    { name: "client_id", label: "Client ID", type: "text" },
    { name: "client_secret", label: "Client secret", type: "password" },
  ],
  presentation: {
    setupDescription: "Enter the client ID and secret from your Yoto developer application. You then sign in on Yoto’s website, so your Yoto password is entered only there.",
    securitySummary: "This server keeps no copy of your client secret or Yoto tokens. They travel encrypted inside the tokens your MCP client holds.",
    affiliationNotice: "Independent software. Not affiliated with or endorsed by Yoto.",
    setupGuide: {
      title: "Create a Yoto application",
      actionLabel: "Yoto developer docs",
      actionUrl: "https://yoto.dev/get-started/start-here/",
      steps: [
        {
          title: "Create an application",
          description: "Sign in to the [Yoto developer dashboard](https://dashboard.yoto.dev/) with your Yoto account and create a new application.",
        },
        {
          title: "Use these settings",
          description: "Choose a **confidential** client ([public vs confidential](https://yoto.dev/get-started/glossary/)), add the callback URL, and select every scope below. Without `offline_access` Yoto issues no refresh token and connecting fails.\n\nYoto labels apps that control players as unverified ([scopes](https://yoto.dev/authentication/scopes/)). That does not limit personal use.",
          settings: [
            { label: "Client type", value: "Confidential" },
            { label: "Callback URL", value: "{origin}/{id}/callback", copy: true },
            { label: "Scopes", value: YOTO_SCOPES, copy: true },
          ],
        },
        {
          title: "Copy the ID and secret",
          description: "Save the application. Its **client ID** and **client secret** go into the connection form. Keep them for reconnecting.",
        },
      ],
    },
  },

  // Yoto rejects authorization requests without PKCE, even for confidential clients.
  authorizeUrl(callbackUrl, state, credentials, env, { codeChallenge }) {
    const url = new URL("/authorize", env.YOTO_AUTH_ORIGIN ?? "https://login.yotoplay.com");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: credentials.client_id,
      redirect_uri: callbackUrl,
      audience: "https://api.yotoplay.com",
      scope: YOTO_SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  },

  async exchangeCode(code, callbackUrl, credentials, env, { codeVerifier }) {
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
        code_verifier: codeVerifier,
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
    registerAuthoringTools(server, client);
    server.registerTool("list_players", {
      description: "List Yoto players in your family, including their device IDs, names and online flags. Does not provide live battery or playback status.",
      annotations: readOnly,
    }, async () => json(await client.request("/device-v2/devices/mine")));

    server.registerTool("list_library", {
      description: "List the family's Yoto library, including purchased and MYO cards, in the Android app's grouped view. Use the card IDs with get_library_card or play_card.",
      annotations: readOnly,
    }, async () => json(await client.request("/card/family/library?view=groups")));

    server.registerTool("get_library_card", {
      description: "Get a library card's details, including available chapter and track keys for play_card. Does not add the card to your family.",
      inputSchema: z.object({ cardId: resourceId, timezone: z.string().min(1).max(100).default("UTC") }),
      annotations: readOnly,
    }, async ({ cardId, timezone }) => json(await client.request(`/card/details/${encodeURIComponent(cardId)}?timezone=${encodeURIComponent(timezone)}`)));

    server.registerTool("play_card", {
      description: "Play a Yoto card on a family player, optionally selecting chapter, track and seconds into the track. Use list_players and list_library/get_library_card for IDs and keys. Can also seek or change tracks by replaying with those keys. Requires an online player and the control scope; acceptance does not confirm playback.",
      inputSchema: z.object({
        deviceId: resourceId,
        cardId: resourceId,
        chapterKey: z.string().min(1).max(256).optional(),
        trackKey: z.string().min(1).max(256).optional(),
        secondsIn: z.number().int().min(0).max(2_147_483_647).default(0),
      }).refine((value) => !value.trackKey || !!value.chapterKey, "A track key requires a chapter key"),
      annotations: playerWrite,
    }, async ({ deviceId, cardId, chapterKey, trackKey, secondsIn }) => json(await client.command(deviceId, "card-play", {
      uri: `https://yoto.io/${cardId}`, chapterKey, trackKey, secondsIn, cutOff: 0,
    })));

    for (const action of ["pause", "resume", "stop"] as const) {
      server.registerTool(`${action}_playback`, {
        description: `${action[0].toUpperCase()}${action.slice(1)} playback on a Yoto family player. Requires the control scope. Acceptance does not confirm execution.`,
        inputSchema: z.object({ deviceId: resourceId }),
        annotations: playerWrite,
      }, async ({ deviceId }) => json(await client.command(deviceId, `card-${action}`)));
    }

    server.registerTool("set_volume", {
      description: "Set a Yoto player's volume from 0 (mute) to 100 percent. The player's configured volume limit still applies.",
      inputSchema: z.object({ deviceId: resourceId, volume: z.number().int().min(0).max(100) }),
      annotations: playerWrite,
    }, async ({ deviceId, volume }) => json(await client.command(deviceId, "set-volume", { volume })));

    server.registerTool("set_sleep_timer", {
      description: "Send the Yoto Android app's sleep timer command, with duration in seconds. Acceptance does not confirm execution.",
      inputSchema: z.object({ deviceId: resourceId, seconds: z.number().int().min(0).max(2_147_483_647) }),
      annotations: playerWrite,
    }, async ({ deviceId, seconds }) => json(await client.command(deviceId, "sleep", { seconds })));

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
