import { z } from "zod";
import { b64url } from "../../seal.js";
import { YotoApiError, type YotoClient } from "./client.js";

export const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
export const hash = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Use a base64url SHA-256 hash without padding");
export const AUDIO_LIMIT = 20 * 1024 * 1024;
export const IMAGE_LIMIT = 5 * 1024 * 1024;

// URL credentials, IP literals, local names and redirects are deliberately unsupported.
// These requests run on Workers' public fetch, never a private service binding.
export function publicUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Provide a public HTTPS media URL"); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      (url.port && url.port !== "443") || !hostname.includes(".") ||
      /^[\d.]+$/.test(hostname) || hostname.includes(":") ||
      /(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(hostname)) {
    throw new Error("Provide a public HTTPS media URL without credentials, IP literals or a custom port");
  }
  return url;
}
export const mediaUrl = z.string().max(8192).refine(value => {
  try { publicUrl(value); return true; } catch { return false; }
}, "Use a public HTTPS media URL");

export async function fetchMedia(url: string, kind: "audio" | "image") {
  const target = publicUrl(url);
  const limit = kind === "audio" ? AUDIO_LIMIT : IMAGE_LIMIT;
  let response: Response;
  try {
    response = await fetch(target.toString(), { redirect: "manual", headers: { "cache-control": "no-store" }, signal: AbortSignal.timeout(30_000) });
  } catch { throw new Error("Could not fetch the media URL; check its accessibility and expiry"); }
  const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  const validType = kind === "audio" ? /^audio\/[a-z0-9.+-]+$/.test(contentType)
    : ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(contentType);
  if (!response.ok || !validType || !response.body || Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Media download rejected: require a direct ${kind} response under ${limit / 1024 / 1024} MiB with the correct Content-Type`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Media is too large");
      chunks.push(value);
    }
    if (!size) throw new Error("Empty media");
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error(`Media download incomplete, empty, or exceeds ${limit / 1024 / 1024} MiB`);
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, contentType };
}

const uploadResponse = z.object({ upload: z.object({ uploadId: id, uploadUrl: z.string().nullable() }) });
export async function prepareAudio(client: YotoClient, sha256: string, filename?: string) {
  const params = new URLSearchParams({ sha256: hash.parse(sha256) });
  if (filename) params.set("filename", filename);
  const parsed = uploadResponse.safeParse(await client.request(`/media/transcode/audio/uploadUrl?${params}`));
  if (!parsed.success) throw new Error("Yoto returned an invalid audio upload response");
  const upload = parsed.data.upload;
  if (upload.uploadUrl !== null) publicUrl(upload.uploadUrl);
  return { ...upload, uploadRequired: upload.uploadUrl !== null, method: "PUT", instruction: "Upload the exact hashed bytes with their audio Content-Type. Do not send Yoto authorization to this signed URL. Then call get_audio_upload." };
}

export async function uploadAudio(client: YotoClient, url: string, filename?: string) {
  const { bytes, contentType } = await fetchMedia(url, "audio");
  const sha256 = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  const upload = await prepareAudio(client, sha256, filename);
  if (upload.uploadUrl) {
    let response: Response;
    try {
      response = await fetch(upload.uploadUrl, { method: "PUT", headers: { "content-type": contentType }, body: bytes,
        redirect: "manual", signal: AbortSignal.timeout(30_000) });
    } catch { throw new Error(`Audio upload outcome unknown. Check get_audio_upload for uploadId ${upload.uploadId} before retrying.`); }
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new Error(`Yoto storage rejected the upload (${response.status}); check uploadId ${upload.uploadId} before retrying`);
  }
  return { uploadId: upload.uploadId, sha256, bytes: bytes.byteLength, reused: !upload.uploadRequired,
    next: "Call get_audio_upload until ready, then use add_audio_to_card or create_playlist. The upload has not modified a card." };
}

const mediaInfo = z.object({ duration: z.number().nonnegative(), fileSize: z.number().nonnegative(),
  format: z.string().min(1), channels: z.union([z.string(), z.number()]).optional(),
}).passthrough();
const transcodeResponse = z.object({ transcode: z.object({
  transcodedSha256: hash.nullish(),
  transcodedInfo: mediaInfo.nullish(),
  mediaInfo: mediaInfo.nullish(),
}).passthrough() });
export async function audioStatus(client: YotoClient, uploadId: string) {
  let response: unknown;
  try { response = await client.request(`/media/upload/${id.parse(uploadId)}/transcoded?loudnorm=false`, undefined, "GET", true); }
  catch (error) {
    if (error instanceof YotoApiError && error.status === 404) return { uploadId, ready: false as const, status: "not_ready_or_not_found" };
    throw error;
  }
  if (response === null) return { uploadId, ready: false as const, status: "pending" };
  const parsed = transcodeResponse.safeParse(response);
  if (!parsed.success) throw new Error("Yoto returned an invalid transcoding status; no playlist was changed");
  const transcode = parsed.data.transcode;
  if (!transcode.transcodedSha256) return { uploadId, ready: false as const, transcode };
  const info = transcode.transcodedInfo ?? transcode.mediaInfo;
  if (!info) throw new Error("Yoto has not returned the transcoded audio metadata yet; check again");
  const channels: "mono" | "stereo" | undefined = info.channels === 1 || info.channels === "mono" ? "mono" : info.channels === 2 || info.channels === "stereo" ? "stereo" : undefined;
  return { uploadId, ready: true as const, transcode, track: {
    trackUrl: `yoto:#${transcode.transcodedSha256}`, type: "audio" as const,
    duration: info.duration, fileSize: info.fileSize, format: info.format,
    ...(channels === "mono" || channels === "stereo" ? { channels } : {}),
  } };
}

export const coverType = z.enum(["default", "activities", "music", "myo", "podcast", "radio", "sfx", "stories"]);
export async function uploadCover(client: YotoClient, url: string, type = "myo") {
  const { bytes, contentType } = await fetchMedia(url, "image");
  const params = new URLSearchParams({ autoconvert: "true", coverType: coverType.parse(type) });
  const parsed = z.object({ coverImage: z.object({ mediaId: id, mediaUrl: mediaUrl }) }).safeParse(
    await client.upload(`/media/coverImage/user/me/upload?${params}`, bytes, contentType));
  if (!parsed.success) throw new Error("Yoto returned an invalid cover response; no card cover was changed");
  return parsed.data.coverImage;
}

export async function uploadIcon(client: YotoClient, url: string, filename?: string) {
  const { bytes, contentType } = await fetchMedia(url, "image");
  const params = new URLSearchParams({ autoConvert: "true" });
  if (filename) params.set("filename", filename);
  const parsed = z.object({ displayIcon: z.object({ mediaId: id }).passthrough() }).safeParse(
    await client.upload(`/media/displayIcons/user/me/upload?${params}`, bytes, contentType));
  if (!parsed.success) throw new Error("Yoto returned an invalid icon upload response");
  return { ...parsed.data.displayIcon, icon16x16: `yoto:#${parsed.data.displayIcon.mediaId}` };
}
