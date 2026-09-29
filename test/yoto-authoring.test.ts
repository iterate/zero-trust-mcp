import { afterEach, beforeEach, expect, test } from "bun:test";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import { YotoClient } from "../src/integrations/yoto/client.ts";
import { registerAuthoringTools } from "../src/integrations/yoto/authoring-tools.ts";
import { AUDIO_LIMIT, IMAGE_LIMIT, publicUrl, fetchMedia } from "../src/integrations/yoto/media.ts";

const originalFetch = globalThis.fetch;
const secret = "yoto-test-secret";
const mediaHash = "A".repeat(43);
const tools = new Map<string, { config: any; handler: (args: any) => Promise<any> }>();
registerAuthoringTools({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } } as unknown as McpServer, new YotoClient(secret));
async function call(name: string, args: any = {}) {
  const tool = tools.get(name)!;
  return JSON.parse((await tool.handler(tool.config.inputSchema.parse(args))).content[0].text);
}
let calls: { url: URL; method: string; headers: Headers; body: any }[];
let card: any;
let config: any;
let uploadRequired: boolean;
let ready: boolean;
let pending404: boolean;
let mediaStatus: number;
let mediaType: string | undefined;
let declaredSize: number | undefined;
let writeStatus: number;
let applyConfig: boolean;
let badSave: boolean;
let mutateDuringTranscode: boolean;
let signedUrl: string;
let malformedUpload: boolean;
let sourceNetworkError: boolean;
let putNetworkError: boolean;
let getConfigError: boolean;
const chapter = (key = "01") => ({ key, title: `Chapter ${key}`, display: { icon16x16: `yoto:#${mediaHash}` },
  tracks: [{ key: "01", title: "Story", type: "audio", format: "aac", trackUrl: `yoto:#${mediaHash}`, duration: 12, fileSize: 321, channels: "mono" }] });
beforeEach(() => {
  calls = []; uploadRequired = true; ready = true; pending404 = false; mediaStatus = 200;
  mediaType = undefined; declaredSize = undefined; writeStatus = 200; applyConfig = true; badSave = false; mutateDuringTranscode = false;
  malformedUpload = false; sourceNetworkError = false; putNetworkError = false; getConfigError = false;
  signedUrl = "https://storage.example.com/upload?private=signature";
  card = { cardId: "my_card", title: "Bedtime", updatedAt: "revision-1", metadata: { description: "Keep me", cover: { imageL: "https://images.example.com/old.png", imageS: "keep-small" }, extra: "keep-metadata" },
    content: { chapters: [chapter()], config: { resumeTimeout: 100 }, playbackType: "linear", extra: "keep-content" } };
  config = { maxVolumeLimit: "16", nightMaxVolumeLimit: "8", repeatAll: true, locale: "en-GB" };
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const body = headers.get("content-type") === "application/json" ? JSON.parse(init?.body as string) : init?.body;
    calls.push({ url, method, headers, body });
    expect(init?.redirect).toBe("manual");
    if (url.hostname === "cdn.example.com") {
      expect(headers.has("authorization")).toBe(false);
      if (sourceNetworkError) throw new Error("private signed source URL must not leak");
      return new Response("hello", { status: mediaStatus, headers: { "content-type": mediaType ?? (url.pathname.endsWith(".mp3") ? "audio/mpeg" : "image/png"), ...(declaredSize !== undefined ? { "content-length": String(declaredSize) } : {}) } });
    }
    if (url.hostname === "storage.example.com") {
      expect(headers.has("authorization")).toBe(false);
      expect(method).toBe("PUT");
      expect(new TextDecoder().decode(body)).toBe("hello");
      expect(headers.get("content-type")).toBe("audio/mpeg");
      if (putNetworkError) throw new Error("private storage URL must not leak");
      return new Response(null, { status: writeStatus });
    }
    expect(url.origin).toBe("https://api.yotoplay.com");
    expect(headers.get("authorization")).toBe(`Bearer ${secret}`);
    if (method !== "GET" && writeStatus !== 200) return new Response(secret, { status: writeStatus });
    if (url.pathname === "/media/transcode/audio/uploadUrl") return Response.json(malformedUpload ? { upload: {} } : { upload: { uploadId: "upload_1", uploadUrl: uploadRequired ? signedUrl : null } });
    if (url.pathname === "/media/upload/upload_1/transcoded") {
      if (pending404) return new Response("pending", { status: 404 });
      if (mutateDuringTranscode) card.title = "Someone else's edit";
      return Response.json({ transcode: ready ? { transcodedSha256: mediaHash, transcodedInfo: { duration: 12, fileSize: 321, format: "aac", channels: 1 } } : {} });
    }
    if (url.pathname === "/media/coverImage/user/me/upload") {
      expect(headers.get("content-type")).toBe("image/png");
      expect(new TextDecoder().decode(body)).toBe("hello");
      expect(url.searchParams.get("autoconvert")).toBe("true");
      return Response.json({ coverImage: { mediaId: "cover_1", mediaUrl: "https://images.example.com/new.png" } });
    }
    if (url.pathname === "/media/displayIcons/user/me/upload") {
      expect(url.searchParams.get("autoConvert")).toBe("true");
      expect(headers.get("content-type")).toBe("image/png");
      return Response.json({ displayIcon: { mediaId: mediaHash, displayIconId: "icon_1" } });
    }
    if (url.pathname.startsWith("/media/displayIcons/user/")) return Response.json({ displayIcons: [{ mediaId: mediaHash }] });
    if (url.pathname === "/content/my_card") return Response.json({ card });
    if (url.pathname === "/content") {
      if (badSave) return Response.json({ ok: true });
      card = { ...body, cardId: body.cardId ?? "new_card" };
      return Response.json({ card });
    }
    if (url.pathname === "/device-v2/ada/config") {
      if (method === "PUT") {
        if (applyConfig) Object.assign(config, body.config);
        return Response.json({ status: "ok" });
      }
      if (getConfigError) return new Response(secret, { status: 503 });
      return Response.json({ device: { name: "Ada", config } });
    }
    throw new Error(`Unexpected mocked endpoint ${url.pathname}`);
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });
const saves = () => calls.filter(c => c.url.pathname === "/content" && c.method === "POST");

test("14 new tools are registered with appropriate mutation annotations", () => {
  expect(tools.size).toBe(14);
  expect(tools.get("update_playlist")!.config.annotations.destructiveHint).toBe(true);
  expect(tools.get("get_playlist")!.config.annotations.readOnlyHint).toBe(true);
});
test("URL audio upload hashes exact bytes, uses bearer only for Yoto, returns a handle", async () => {
  const result = await call("upload_audio", { url: "https://cdn.example.com/story.mp3?token=private", filename: "Story" });
  expect(result.uploadId).toBe("upload_1"); expect(result.bytes).toBe(5); expect(result.reused).toBe(false);
  expect(result.sha256).toBe(createHash("sha256").update("hello").digest("base64url"));
  const request = calls.find(c => c.url.pathname.endsWith("/uploadUrl"))!;
  expect(request.url.searchParams.get("sha256")).toBe(result.sha256);
  expect(request.url.searchParams.get("filename")).toBe("Story");
  expect(JSON.stringify(result)).not.toContain("private"); expect(saves()).toHaveLength(0);
});
test("deduplicated audio skips storage PUT", async () => {
  uploadRequired = false;
  expect((await call("upload_audio", { url: "https://cdn.example.com/story.mp3" })).reused).toBe(true);
  expect(calls.some(c => c.method === "PUT")).toBe(false);
});
test("direct local upload returns signed handoff; rejects malformed hashes before network", async () => {
  expect((await call("prepare_audio_upload", { sha256: mediaHash })).uploadRequired).toBe(true);
  const n = calls.length;
  await expect(call("prepare_audio_upload", { sha256: "wrong" })).rejects.toThrow(); expect(calls).toHaveLength(n);
});
for (const url of ["file:///tmp/a", "https://127.0.0.1/a", "https://2130706433/a", "https://[::1]/a", "https://user:pass@example.com/a", "https://a.internal/a", "http://example.com/a", "https://example.com:8000/a"]) {
  test(`refuses unsafe source URL ${url}`, async () => {
    expect(() => publicUrl(url)).toThrow(); await expect(call("upload_audio", { url })).rejects.toThrow(); expect(calls).toHaveLength(0);
  });
}
for (const mode of ["redirect", "html", "size", "network"]) test(`download ${mode} never starts a Yoto upload`, async () => {
  if (mode === "redirect") mediaStatus = 302;
  if (mode === "html") mediaType = "text/html";
  if (mode === "size") declaredSize = AUDIO_LIMIT + 1;
  if (mode === "network") sourceNetworkError = true;
  await expect(call("upload_audio", { url: "https://cdn.example.com/story.mp3" })).rejects.toThrow();
  expect(calls).toHaveLength(1);
});
test("actual streamed bytes are bounded when Content-Length lies or is absent", async () => {
  let canceled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(IMAGE_LIMIT + 1)); }, cancel() { canceled = true; } }), { headers: { "content-type": "image/png" } })) as typeof fetch;
  await expect(fetchMedia("https://cdn.example.com/image.png", "image")).rejects.toThrow("exceeds"); expect(canceled).toBe(true);
});
test("malformed upload ticket and unsafe storage URL are rejected", async () => {
  malformedUpload = true;
  await expect(call("prepare_audio_upload", { sha256: mediaHash })).rejects.toThrow("invalid audio upload");
  malformedUpload = false; signedUrl = "https://127.0.0.1/upload";
  await expect(call("prepare_audio_upload", { sha256: mediaHash })).rejects.toThrow("public HTTPS");
});
test("lost storage response is not retried and identifies the upload", async () => {
  putNetworkError = true;
  await expect(call("upload_audio", { url: "https://cdn.example.com/story.mp3" })).rejects.toThrow("Check get_audio_upload for uploadId upload_1");
  expect(calls.filter(c => c.method === "PUT")).toHaveLength(1);
});
test("transcoding pending, not found, and ready states are distinct from a saved card", async () => {
  ready = false; expect((await call("get_audio_upload", { uploadId: "upload_1" })).ready).toBe(false);
  pending404 = true; expect((await call("get_audio_upload", { uploadId: "upload_1" })).status).toBe("not_ready_or_not_found");
  pending404 = false; ready = true;
  const result = await call("get_audio_upload", { uploadId: "upload_1" });
  expect(result.track.trackUrl).toBe(`yoto:#${mediaHash}`); expect(result.track.channels).toBe("mono"); expect(saves()).toHaveLength(0);
});
test("create supports ordered multiple tracks, labels, icons, cover and shuffle", async () => {
  const first = chapter(); first.tracks.push({ ...first.tracks[0]!, key: "02", title: "Second" });
  const second: any = chapter("02"); second.tracks[0] = { ...second.tracks[0], type: "stream", trackUrl: "https://cdn.example.com/live.mp3", overlayLabelOverride: "S", display: { icon16x16: `yoto:#${mediaHash}` } };
  const result = await call("create_playlist", { title: "Stories", chapters: [first, second], metadata: { cover: { imageL: "https://images.example.com/cover.png" } }, config: { shuffle: [{ start: 0, end: 1, limit: 2 }] } });
  expect(result.card.content.chapters[0].tracks.map((t: any) => t.key)).toEqual(["01", "02"]);
  expect(result.card.content.chapters[1].tracks[0].display.icon16x16).toBe(`yoto:#${mediaHash}`);
});
test("rejects duplicate keys, invalid audio references and invalid shuffle before saving", async () => {
  await expect(call("create_playlist", { title: "x", chapters: [chapter(), chapter()] })).rejects.toThrow();
  const invalid: any = chapter(); invalid.tracks[0].trackUrl = "https://example.com/raw.mp3";
  await expect(call("create_playlist", { title: "x", chapters: [invalid] })).rejects.toThrow();
  await expect(call("create_playlist", { title: "x", chapters: [chapter()], config: { shuffle: [{ start: 0, end: 1, limit: 2 }] } })).rejects.toThrow("Shuffle");
  expect(saves()).toHaveLength(0);
});
test("cover changes preserve all tracks, content config, and unrelated metadata", async () => {
  const { revision } = await call("get_playlist", { cardId: "my_card" }); const old = structuredClone(card);
  await call("set_card_cover", { cardId: "my_card", expectedRevision: revision, imageUrl: "https://cdn.example.com/cover.png" });
  expect(card.content).toEqual(old.content); expect(card.metadata.description).toBe("Keep me");
  expect(card.metadata.cover.imageS).toBe("keep-small"); expect(card.metadata.cover.imageL).toBe("https://images.example.com/new.png");
  expect(card.metadata.extra).toBe("keep-metadata");
});
test("stale playlist revision blocks all changes", async () => {
  const { revision } = await call("get_playlist", { cardId: "my_card" }); card.title = "changed";
  await expect(call("update_playlist", { cardId: "my_card", expectedRevision: revision, title: "overwrite" })).rejects.toThrow("changed since");
  expect(saves()).toHaveLength(0);
});
test("chapter replacement intentionally permits reorder/removal while preserving config", async () => {
  card.content.chapters.push(chapter("02"));
  const { revision } = await call("get_playlist", { cardId: "my_card" });
  await call("update_playlist", { cardId: "my_card", expectedRevision: revision, chapters: [chapter("02")] });
  expect(card.content.chapters.map((c: any) => c.key)).toEqual(["02"]); expect(card.content.config.resumeTimeout).toBe(100);
});
test("append keeps existing chapters and uses provider media metadata", async () => {
  const { revision } = await call("get_playlist", { cardId: "my_card" });
  await call("add_audio_to_card", { cardId: "my_card", expectedRevision: revision, tracks: [{ uploadId: "upload_1", title: "New sound" }] });
  expect(card.content.chapters).toHaveLength(2); expect(card.content.chapters[0]).toEqual(chapter());
  expect(card.content.chapters[1].tracks[0].fileSize).toBe(321); expect(card.metadata.extra).toBe("keep-metadata");
});
for (const mode of ["pending", "concurrent"]) test(`append ${mode} leaves playlist unsaved`, async () => {
  const { revision } = await call("get_playlist", { cardId: "my_card" });
  ready = mode !== "pending"; mutateDuringTranscode = mode === "concurrent";
  await expect(call("add_audio_to_card", { cardId: "my_card", expectedRevision: revision, tracks: [{ uploadId: "upload_1", title: "New" }] })).rejects.toThrow();
  expect(saves()).toHaveLength(0);
});
test("new card from uploads and cover/icon tools complete", async () => {
  expect((await call("add_audio_to_card", { title: "New", tracks: [{ uploadId: "upload_1", title: "sound" }] })).card.cardId).toBe("new_card");
  expect((await call("upload_cover_image", { imageUrl: "https://cdn.example.com/art.png" })).mediaUrl).toBe("https://images.example.com/new.png");
  expect((await call("upload_icon", { imageUrl: "https://cdn.example.com/icon.png", filename: "Moon" })).icon16x16).toBe(`yoto:#${mediaHash}`);
  await call("list_icons", { source: "mine" }); await call("list_icons");
  expect(calls.some(c => c.url.pathname === "/media/displayIcons/user/yoto")).toBe(true);
});
test("Ada max volume 10 sets both limits as native strings, preserves other settings", async () => {
  const result = await call("set_volume_limit", { deviceId: "ada", limit: 10 });
  const put = calls.find(c => c.method === "PUT")!;
  expect(put.body).toEqual({ config: { maxVolumeLimit: "10", nightMaxVolumeLimit: "10" } });
  expect(result.verified).toBe(true); expect(config.repeatAll).toBe(true); expect(config.locale).toBe("en-GB");
});
test("day-only volume does not overwrite the night limit", async () => {
  await call("set_volume_limit", { deviceId: "ada", limit: 10, period: "day" });
  expect(config.nightMaxVolumeLimit).toBe("8");
  expect(calls.find(c => c.method === "PUT")!.body).toEqual({ config: { maxVolumeLimit: "10" } });
});
test("config times, booleans and numeric timeout serialization", async () => {
  await call("update_player_config", { deviceId: "ada", config: { nightTime: "19:30", repeatAll: false, shutdownTimeout: 1800 } });
  expect(config.shutdownTimeout).toBe("1800"); expect(config.repeatAll).toBe(false);
  const n = calls.length;
  await expect(call("set_volume_limit", { deviceId: "ada", limit: 17 })).rejects.toThrow();
  await expect(call("update_player_config", { deviceId: "ada", config: { nightTime: "25:90" } })).rejects.toThrow();
  await expect(call("update_player_config", { deviceId: "ada", config: { unknown: "bad" } })).rejects.toThrow();
  expect(calls).toHaveLength(n);
});
test("config accepted but not applied/readable is not claimed verified", async () => {
  applyConfig = false; expect((await call("set_volume_limit", { deviceId: "ada", limit: 10 })).verified).toBe(false);
  getConfigError = true; expect((await call("set_volume_limit", { deviceId: "ada", limit: 10 })).verified).toBe(false);
});
test("failed mutations are redacted and not retried", async () => {
  writeStatus = 403;
  try { await call("set_volume_limit", { deviceId: "ada", limit: 10 }); throw new Error("expected failure"); }
  catch (error) { expect(String(error)).toContain("403"); expect(String(error)).not.toContain(secret); }
  expect(calls.filter(c => c.method === "PUT")).toHaveLength(1);
});
test("malformed successful save does not claim the card was saved", async () => {
  badSave = true;
  await expect(call("create_playlist", { title: "x", chapters: [chapter()] })).rejects.toThrow("outcome is unknown");
  expect(saves()).toHaveLength(1);
});


test("all authoring tool schemas serialize for MCP discovery", () => {
  for (const tool of tools.values()) {
    const schema = z.toJSONSchema(tool.config.inputSchema, { io: "input" });
    expect(schema.type).toBe("object");
  }
});
test("native mediaInfo alias produces the same ready track", async () => {
  globalThis.fetch = (async () => Response.json({ transcode: { transcodedSha256: mediaHash, mediaInfo: { duration: 12, fileSize: 321, format: "aac", channels: 2 } } })) as typeof fetch;
  expect((await call("get_audio_upload", { uploadId: "upload_1" })).track.channels).toBe("stereo");
});
test("null optional provider metadata/config can be edited", async () => {
  card.metadata = null; card.content.config = null;
  const { revision } = await call("get_playlist", { cardId: "my_card" });
  await call("update_playlist", { cardId: "my_card", expectedRevision: revision, title: "New title" });
  expect(card.title).toBe("New title"); expect(card.content.chapters).toHaveLength(1);
});

test("empty conversion response stays pending; empty content response is an error", async () => {
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  expect((await call("get_audio_upload", { uploadId: "upload_1" })).ready).toBe(false);
  await expect(call("get_playlist", { cardId: "my_card" })).rejects.toThrow("invalid or incomplete response");
});
test("empty native config acknowledgement is checked by reading config", async () => {
  globalThis.fetch = (async (_input, init) => init?.method === "PUT" ? new Response(null, { status: 200 }) : Response.json({ device: { config: { maxVolumeLimit: "10", nightMaxVolumeLimit: "10" } } })) as typeof fetch;
  expect((await call("set_volume_limit", { deviceId: "ada", limit: 10 })).verified).toBe(true);
});
