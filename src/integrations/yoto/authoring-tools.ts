import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { YotoClient } from "./client.js";
import { id, hash, mediaUrl, coverType, prepareAudio, uploadAudio, audioStatus, uploadCover, uploadIcon } from "./media.js";
import { createPlaylistSchema, updatePlaylistSchema, uploadedTracksSchema, getPlaylist, createPlaylist, updatePlaylist, addAudio } from "./playlists.js";
import { volumeLimit, settingsSchema, getPlayerConfig, updatePlayerConfig } from "./settings.js";

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const edit = { ...write, destructiveHint: true };
const filename = z.string().min(1).max(200).optional();

export function registerAuthoringTools(server: McpServer, client: YotoClient) {
  server.registerTool("upload_audio", {
    description: "Import audio from a direct HTTPS URL into Yoto (max 20 MiB, audio Content-Type). Temporary signed URLs work. Returns an uploadId; poll get_audio_upload then add_audio_to_card. Does not change a card. No redirects or local URLs; no Yoto credentials are sent to the source or storage URL.",
    inputSchema: z.object({ url: mediaUrl, filename }), annotations: write,
  }, async ({ url, filename }) => json(await uploadAudio(client, url, filename)));
  server.registerTool("prepare_audio_upload", {
    description: "Prepare direct upload of a local/large audio file by a client with filesystem access. Supply its SHA-256 as unpadded base64url (43 chars). PUT the exact bytes to the returned signed URL using the audio Content-Type and NO Authorization header. uploadRequired=false means skip PUT. Then poll get_audio_upload. Treat the signed URL as private.",
    inputSchema: z.object({ sha256: hash, filename }), annotations: write,
  }, async ({ sha256, filename }) => json(await prepareAudio(client, sha256, filename)));
  server.registerTool("get_audio_upload", {
    description: "Check audio conversion once. If ready=false, check again later; do not create a card yet. When ready, returns an audio track reference and media metadata for create_playlist, or use add_audio_to_card with the uploadId.",
    inputSchema: z.object({ uploadId: id }), annotations: read,
  }, async ({ uploadId }) => json(await audioStatus(client, uploadId)));
  server.registerTool("get_playlist", {
    description: "Read MYO playlist content and a revision for editing. Retain chapters, tracks, labels and icons when constructing an update. Use the returned revision as expectedRevision; purchased cards are not editable MYO content.",
    inputSchema: z.object({ cardId: id }), annotations: read,
  }, async ({ cardId }) => json(await getPlaylist(client, cardId)));
  server.registerTool("create_playlist", {
    description: "Create a MYO playlist with multiple ordered chapters/tracks, uploaded audio or HTTPS streams, labels, chapter/track icons, cover metadata and optional shuffle ranges. Audio trackUrl must be a finished yoto:# hash. Use upload_audio/get_audio_upload first. Retrying creates another playlist. Physical-card linking still uses the app/player.",
    inputSchema: createPlaylistSchema, annotations: write,
  }, async args => json(await createPlaylist(client, args)));
  server.registerTool("update_playlist", {
    description: "Edit a MYO playlist using expectedRevision from get_playlist. Omitted title/content/metadata/config fields are preserved. Supplying chapters REPLACES the entire chapter list: include every chapter/track to keep, in the desired order. Supports renaming, reordering, removal, icons, covers and shuffle. Revision is a preflight check, not an atomic lock; avoid concurrent edits.",
    inputSchema: updatePlaylistSchema, annotations: edit,
  }, async args => json(await updatePlaylist(client, args)));
  server.registerTool("add_audio_to_card", {
    description: "Append finished audio uploads as new chapters, preserving existing tracks and cover. For an existing MYO card supply cardId and expectedRevision from get_playlist; for a new playlist omit cardId and supply title. All uploads must be ready. Retrying can duplicate chapters.",
    inputSchema: z.object({ cardId: id.optional(), expectedRevision: z.string().min(1).max(128).optional(), title: z.string().trim().min(1).max(200).optional(), tracks: uploadedTracksSchema })
      .refine(v => v.cardId ? !!v.expectedRevision : !!v.title, "Existing cards require a revision; new playlists require a title"), annotations: write,
  }, async args => json(await addAudio(client, args)));
  server.registerTool("upload_cover_image", {
    description: "Upload cover artwork from a direct HTTPS JPEG/PNG/GIF/WebP URL (max 5 MiB). Yoto resizes/crops it for the selected coverType. Returns mediaUrl for metadata.cover.imageL in create_playlist/update_playlist; does not modify a card.",
    inputSchema: z.object({ imageUrl: mediaUrl, coverType: coverType.default("myo") }), annotations: write,
  }, async ({ imageUrl, coverType }) => json(await uploadCover(client, imageUrl, coverType)));
  server.registerTool("set_card_cover", {
    description: "Upload cover artwork from an HTTPS image URL and change an existing MYO card's cover, preserving all tracks and other metadata. Requires expectedRevision from get_playlist. Artwork is for the app/library; player pixel icons are set separately.",
    inputSchema: z.object({ cardId: id, expectedRevision: z.string().min(1).max(128), imageUrl: mediaUrl, coverType: coverType.default("myo") }), annotations: edit,
  }, async ({ cardId, expectedRevision, imageUrl, coverType }) => {
    if ((await getPlaylist(client, cardId)).revision !== expectedRevision) throw new Error("Playlist changed; get_playlist again before changing its cover");
    const cover = await uploadCover(client, imageUrl, coverType);
    return json(await updatePlaylist(client, { cardId, expectedRevision, metadata: { cover: { imageL: cover.mediaUrl } } }));
  });
  server.registerTool("list_icons", {
    description: "List Yoto public or your custom pixel icons. Use yoto:# plus mediaId in chapter/track display.icon16x16.",
    inputSchema: z.object({ source: z.enum(["public", "mine"]).default("public") }), annotations: read,
  }, async ({ source }) => json(await client.request(`/media/displayIcons/user/${source === "public" ? "yoto" : "me"}`)));
  server.registerTool("upload_icon", {
    description: "Upload a custom player pixel icon from a direct HTTPS image URL (max 5 MiB). Yoto auto-converts to 16x16. Returns icon16x16 for a chapter or track. This is separate from the card's cover artwork.",
    inputSchema: z.object({ imageUrl: mediaUrl, filename }), annotations: write,
  }, async ({ imageUrl, filename }) => json(await uploadIcon(client, imageUrl, filename)));
  server.registerTool("get_player_config", {
    description: "Get a player's stored settings: day/night volume limits and schedules, display, Bluetooth, headphones and more. Use list_players to match a person's player name to its deviceId; ask if ambiguous. Requires family:devices:manage and reconnection.",
    inputSchema: z.object({ deviceId: id }), annotations: read,
  }, async ({ deviceId }) => json(await getPlayerConfig(client, deviceId)));
  server.registerTool("update_player_config", {
    description: "Update only supplied player settings or name, then read back the stored config. Volume limits use 0–16 steps; timeout values are seconds; day/night times use HH:MM. Other string settings use native values returned by get_player_config. Requires family:devices:manage. An offline player may apply changes later.",
    inputSchema: settingsSchema, annotations: edit,
  }, async args => json(await updatePlayerConfig(client, args)));
  server.registerTool("set_volume_limit", {
    description: "Set maximum allowed player volume on the app's 0–16 scale (10 means step 10, not 10%). Defaults to both day and night; specify period to change only one. Match Ada's/player names through list_players first; ask if ambiguous. Does not set current playback volume. Requires family:devices:manage and reconnection.",
    inputSchema: z.object({ deviceId: id, limit: volumeLimit, period: z.enum(["day", "night", "both"]).default("both") }), annotations: edit,
  }, async ({ deviceId, limit, period }) => json(await updatePlayerConfig(client, { deviceId, config: {
    ...(period !== "night" ? { maxVolumeLimit: limit } : {}), ...(period !== "day" ? { nightMaxVolumeLimit: limit } : {}),
  } })));
}
