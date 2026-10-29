// SPDX-License-Identifier: AGPL-3.0-only
// Shared helpers for API keys, device codes and constant-time comparison. No database access here.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export const KEY_PREFIX = "pb_live_";
/** 32 random bytes need 43 base62 characters (62^43 > 2^256). */
const KEY_BODY_LENGTH = 43;

/** Encodes bytes as base62, left padded to a fixed length so every key has the same shape. */
export function base62(bytes: Uint8Array, length = KEY_BODY_LENGTH): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out.padStart(length, "0");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export type NewKey = { key: string; prefix: string; hash: string };

/** A new API key: `pb_live_` plus 32 random bytes in base62. Only the hash is stored; the key is shown once. */
export function generateApiKey(): NewKey {
  const key = KEY_PREFIX + base62(randomBytes(32));
  return { key, prefix: keyPrefix(key), hash: sha256Hex(key) };
}

/** The part of a key that is safe to show and log: `pb_live_` plus the first four characters. */
export function keyPrefix(key: string): string {
  return key.slice(0, KEY_PREFIX.length + 4);
}

const KEY_RE = /^pb_live_[0-9A-Za-z]{20,64}$/;

/** Reads `Authorization: Bearer pb_live_...`. Returns null for anything that cannot be one of our keys. */
export function parseBearer(header: string | string[] | undefined): string | null {
  const h = Array.isArray(header) ? header[0] : header;
  if (!h) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  if (!m || !KEY_RE.test(m[1])) return null;
  return m[1];
}

/** Constant-time string comparison. Both sides are hashed first, so length differences leak nothing either. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Random opaque token for a device code (the secret the CLI polls with). */
export function generateDeviceCode(): string {
  return base62(randomBytes(32));
}

/** Letters and digits without look-alikes: no 0/O, 1/I/L, 5/S, 2/Z, 8/B, vowels (so no words). */
export const USER_CODE_ALPHABET = "CDFGHJKMNPQRTVWXY3469";
export const USER_CODE_RE = /^[CDFGHJKMNPQRTVWXY3469]{4}-[CDFGHJKMNPQRTVWXY3469]{4}$/;

/** A code a person types in a browser: XXXX-XXXX. */
export function generateUserCode(): string {
  const pick = () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  let a = "";
  let b = "";
  for (let i = 0; i < 4; i++) {
    a += pick();
    b += pick();
  }
  return `${a}-${b}`;
}

/** Accepts what people type ("abcd efgh", "ABCDEFGH", "abcd-efgh") and returns XXXX-XXXX, or null if it cannot be a code. */
export function normalizeUserCode(input: string): string | null {
  const s = (input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length !== 8) return null;
  const code = `${s.slice(0, 4)}-${s.slice(4)}`;
  return USER_CODE_RE.test(code) ? code : null;
}

/** Short random id for error responses and logs. */
export function requestId(): string {
  return `req_${randomBytes(8).toString("hex")}`;
}
