// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { generateApiKey, generateDeviceCode, generateUserCode, normalizeUserCode, parseBearer, safeEqual, sha256Hex, USER_CODE_ALPHABET, USER_CODE_RE } from "@/server/keys";

describe("api keys", () => {
  it("generates pb_live_ keys with 32 random bytes in base62", () => {
    const k = generateApiKey();
    expect(k.key).toMatch(/^pb_live_[0-9A-Za-z]{43}$/);
    expect(k.prefix).toBe(k.key.slice(0, 12));
    expect(k.hash).toBe(createHash("sha256").update(k.key).digest("hex"));
    expect(k.hash).toBe(sha256Hex(k.key));
  });

  it("never repeats", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateApiKey().key));
    expect(seen.size).toBe(200);
  });

  it("parses only well formed bearer headers", () => {
    const { key } = generateApiKey();
    expect(parseBearer(`Bearer ${key}`)).toBe(key);
    expect(parseBearer(`bearer ${key}`)).toBe(key);
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer("Bearer nope")).toBeNull();
    expect(parseBearer(`Basic ${key}`)).toBeNull();
    expect(parseBearer(`Bearer ${key} extra`)).toBeNull();
    expect(parseBearer("Bearer pb_live_short")).toBeNull();
  });

  it("compares in constant time and handles different lengths", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("device codes", () => {
  it("makes user codes in the XXXX-XXXX form without look-alike characters", () => {
    for (let i = 0; i < 300; i++) {
      const c = generateUserCode();
      expect(c).toMatch(USER_CODE_RE);
      expect(c).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(c).not.toMatch(/[01OIL5SZ28BAEU]/);
    }
    expect(USER_CODE_ALPHABET).not.toMatch(/[01OIL]/);
  });

  it("normalizes what people type", () => {
    expect(normalizeUserCode("cdfg-hjkm")).toBe("CDFG-HJKM");
    expect(normalizeUserCode(" cdfg hjkm ")).toBe("CDFG-HJKM");
    expect(normalizeUserCode("CDFGHJKM")).toBe("CDFG-HJKM");
    expect(normalizeUserCode("CDFG-HJK")).toBeNull();
    expect(normalizeUserCode("AAAA-AAAA")).toBeNull();
    expect(normalizeUserCode("")).toBeNull();
  });

  it("makes long device codes", () => {
    const a = generateDeviceCode();
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).not.toBe(generateDeviceCode());
  });
});
