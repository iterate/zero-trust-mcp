/**
 * Stateless token sealing: AES-256-GCM encrypted JSON blobs.
 *
 * Format: base64url( version(1 byte) || iv(12 bytes) || ciphertext+tag )
 *
 * GCM provides both confidentiality and integrity, so a sealed blob can be
 * handed to untrusted parties (MCP clients) and later trusted on return —
 * no server-side storage required. Expiry lives inside the payload.
 */

const VERSION = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let cachedKey: { secret: string; key: CryptoKey } | null = null;

async function getKey(secret: string): Promise<CryptoKey> {
  if (cachedKey?.secret === secret) return cachedKey.key;
  const raw = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("SEAL_KEY must be 32 bytes, base64-encoded");
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  cachedKey = { secret, key };
  return key;
}

export function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export async function seal(payload: unknown, secret: string): Promise<string> {
  const key = await getKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  const out = new Uint8Array(1 + iv.length + ciphertext.length);
  out[0] = VERSION;
  out.set(iv, 1);
  out.set(ciphertext, 13);
  return b64url(out);
}

/** Returns null on any failure: wrong key, tampered blob, malformed input. */
export async function unseal<T>(token: string, secret: string): Promise<T | null> {
  try {
    const bytes = fromB64url(token);
    if (bytes[0] !== VERSION || bytes.length < 14) return null;
    const key = await getKey(secret);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(1, 13) },
      key,
      bytes.slice(13),
    );
    return JSON.parse(decoder.decode(plaintext)) as T;
  } catch {
    return null;
  }
}

export async function sha256b64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return b64url(new Uint8Array(digest));
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
