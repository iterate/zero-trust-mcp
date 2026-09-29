import { z } from "zod";
import { sha256b64url } from "../../seal.js";
import type { YotoClient } from "./client.js";
import { audioStatus, id, mediaUrl } from "./media.js";

const label = z.string().max(100);
const key = z.string().min(1).max(256);
const title = z.string().trim().min(1).max(200);
const icon = z.string().max(2048).regex(/^yoto:[A-Za-z0-9_#-]+$/);
const display = z.strictObject({ icon16x16: icon.nullable() });
export const trackSchema = z.strictObject({
  key, title, trackUrl: z.string().min(1).max(8192),
  type: z.enum(["audio", "stream"]), format: z.string().min(1).max(32),
  overlayLabel: label.optional(), overlayLabelOverride: label.nullable().optional(),
  uid: z.string().max(256).nullable().optional(), display: display.nullable().optional(),
  duration: z.number().finite().nonnegative().optional(), fileSize: z.number().int().nonnegative().optional(),
  channels: z.enum(["mono", "stereo"]).optional(),
}).superRefine((track, ctx) => {
  const valid = track.type === "audio" ? /^yoto:#[A-Za-z0-9_-]{43}$/.test(track.trackUrl) : mediaUrl.safeParse(track.trackUrl).success;
  if (!valid) ctx.addIssue({ code: "custom", path: ["trackUrl"], message: "Audio needs a transcoded yoto:# hash; streams need an HTTPS URL" });
});
export const chapterSchema = z.strictObject({
  key, title, tracks: z.array(trackSchema).min(1).max(500),
  display: display.default({ icon16x16: null }),
  overlayLabel: label.optional(), overlayLabelOverride: label.nullable().optional(),
  defaultTrackDisplay: z.string().max(2048).nullable().optional(),
  defaultTrackAmbient: z.string().max(2048).nullable().optional(),
  duration: z.number().finite().nonnegative().optional(), fileSize: z.number().int().nonnegative().optional(),
}).refine(chapter => new Set(chapter.tracks.map(t => t.key)).size === chapter.tracks.length, "Track keys must be unique within each chapter");
export const chaptersSchema = z.array(chapterSchema).min(1).max(100)
  .refine(chapters => new Set(chapters.map(c => c.key)).size === chapters.length, "Chapter keys must be unique");
export const playlistConfigSchema = z.strictObject({
  resumeTimeout: z.number().int().nonnegative().optional(),
  shuffle: z.array(z.strictObject({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), limit: z.number().int().positive() })).max(100).optional(),
});
export const metadataSchema = z.strictObject({
  description: z.string().max(10000).optional(),
  cover: z.strictObject({ imageL: mediaUrl.nullable() }).optional(),
});
export const createPlaylistSchema = z.strictObject({ title, chapters: chaptersSchema, metadata: metadataSchema.optional(), config: playlistConfigSchema.optional() });
export const updatePlaylistSchema = z.strictObject({
  cardId: id, expectedRevision: z.string().min(1).max(128),
  title: title.optional(), chapters: chaptersSchema.optional(), metadata: metadataSchema.optional(), config: playlistConfigSchema.optional(),
}).refine(value => [value.title, value.chapters, value.metadata, value.config].some(v => v !== undefined), "Supply at least one change");

const cardSchema = z.object({
  cardId: id, title: z.string(),
  content: z.object({ chapters: z.array(z.object({ key: z.string() }).passthrough()), config: z.record(z.string(), z.unknown()).nullish() }).passthrough(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
}).passthrough();
type Card = z.infer<typeof cardSchema>;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export async function getPlaylist(client: YotoClient, cardId: string) {
  const data = await client.request(`/content/${id.parse(cardId)}`);
  const parsed = z.object({ card: cardSchema }).safeParse(data);
  if (!parsed.success || parsed.data.card.cardId !== cardId) throw new Error("Yoto returned an invalid editable playlist");
  const card = parsed.data.card;
  const revision = await sha256b64url(canonical(card));
  return { card, revision };
}
function checkShuffle(content: Card["content"]) {
  const ranges = content.config?.shuffle;
  if (ranges === undefined) return;
  const parsed = playlistConfigSchema.shape.shuffle.parse(ranges)!;
  let previousEnd = -1;
  for (const range of parsed) {
    if (range.start <= previousEnd || range.end < range.start || range.end >= content.chapters.length || range.limit > range.end - range.start + 1) {
      throw new Error("Shuffle ranges must be ordered, non-overlapping, inside the chapter list, and have a valid limit");
    }
    previousEnd = range.end;
  }
}
async function save(client: YotoClient, body: Record<string, unknown>) {
  const result = await client.request("/content", body);
  const parsed = z.object({ card: z.object({ cardId: id }).passthrough() }).safeParse(result);
  if (!parsed.success || (body.cardId && parsed.data.card.cardId !== body.cardId)) throw new Error("Playlist save outcome is unknown; inspect your library before retrying");
  return result;
}
export async function createPlaylist(client: YotoClient, input: z.infer<typeof createPlaylistSchema>) {
  const value = createPlaylistSchema.parse(input);
  const content = { chapters: value.chapters, ...(value.config ? { config: value.config } : {}) };
  checkShuffle(content);
  return save(client, { title: value.title, content, ...(value.metadata ? { metadata: value.metadata } : {}) });
}
export async function updatePlaylist(client: YotoClient, input: z.infer<typeof updatePlaylistSchema>) {
  const value = updatePlaylistSchema.parse(input);
  const { card, revision } = await getPlaylist(client, value.cardId);
  if (revision !== value.expectedRevision) throw new Error("Playlist changed since it was read. Get the playlist again and review your changes.");
  const content = { ...card.content, ...(value.chapters ? { chapters: value.chapters } : {}),
    ...(value.config ? { config: { ...card.content.config, ...value.config } } : {}) };
  checkShuffle(content);
  const metadata = { ...card.metadata, ...value.metadata };
  if (value.metadata?.cover) metadata.cover = { ...(card.metadata?.cover as object ?? {}), ...value.metadata.cover };
  // Only writable top-level fields, preserving all fetched content and metadata.
  // Yoto has no documented atomic compare-and-swap: revision is a preflight guard.
  return save(client, { cardId: card.cardId, title: value.title ?? card.title, content, metadata });
}

export const uploadedTracksSchema = z.array(z.strictObject({ uploadId: id, title, icon16x16: icon.optional() })).min(1).max(20);
export async function addAudio(client: YotoClient, input: {
  cardId?: string; expectedRevision?: string; title?: string; tracks: z.infer<typeof uploadedTracksSchema>;
}) {
  const existing = input.cardId ? await getPlaylist(client, input.cardId) : undefined;
  if (existing && existing.revision !== input.expectedRevision) throw new Error("Get the playlist and supply its current revision before adding tracks");
  if (!existing && !input.title) throw new Error("A title is required for a new playlist");
  const chapters: z.infer<typeof chapterSchema>[] = [];
  for (const track of uploadedTracksSchema.parse(input.tracks)) {
    const status = await audioStatus(client, track.uploadId);
    if (!status.ready) throw new Error(`Audio upload ${track.uploadId} is not ready. No playlist was changed.`);
    chapters.push({ key: crypto.randomUUID(), title: track.title, display: { icon16x16: track.icon16x16 ?? null },
      tracks: [{ key: "01", title: track.title, ...status.track }] });
  }
  if (!existing) return createPlaylist(client, { title: input.title!, chapters });
  // Existing provider fields are retained; do not round-trip them through the input schema.
  const latest = await getPlaylist(client, input.cardId!);
  if (latest.revision !== existing.revision) throw new Error("Playlist changed during upload checks; read it again before adding tracks");
  const content = { ...latest.card.content, chapters: [...latest.card.content.chapters, ...chapters] };
  if (content.chapters.length > 100) throw new Error("The resulting playlist exceeds 100 chapters");
  checkShuffle(content);
  return save(client, { cardId: latest.card.cardId, title: latest.card.title, content, metadata: latest.card.metadata });
}
