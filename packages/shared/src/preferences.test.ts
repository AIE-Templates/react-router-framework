// Electron layer: host request and preference protocol.
import { describe, expect, it } from "vitest";

import {
  applyPreference,
  isPreferenceKey,
  isPreferenceValue,
  PREFERENCE_COOKIE_PREFIX,
  PREFERENCE_LIMITS,
  preferenceCookieValue,
  preferenceCookiesSize,
  preferencesFromCookies,
  preferencesSize,
  sanitizePreferences,
} from "./preferences.ts";

describe("preference rules", () => {
  it("accepts short cookie-safe keys starting with a letter", () => {
    for (const key of ["theme", "sidebarWidth", "a", "editor.font-size", "x_1", "a".repeat(64)])
      expect(isPreferenceKey(key)).toBe(true);
    for (const key of ["", "1st", "_x", "-x", "a b", "a=b", "a;b", "é", "__proto__", "a".repeat(65), 1, null])
      expect(isPreferenceKey(key)).toBe(false);
  });

  it("accepts strings up to the limit, finite numbers and booleans", () => {
    for (const value of ["", "dark", "x".repeat(PREFERENCE_LIMITS.stringLength), 0, -1.5, true, false])
      expect(isPreferenceValue(value)).toBe(true);
    for (const value of ["x".repeat(PREFERENCE_LIMITS.stringLength + 1), Number.NaN, Infinity, null, undefined, {}, []])
      expect(isPreferenceValue(value)).toBe(false);
  });

  it("measures the size as ASCII JSON, non-ASCII characters as \\uXXXX escapes", () => {
    expect(preferencesSize({ a: "b" })).toBe('{"a":"b"}'.length);
    expect(preferencesSize({ a: "\u4e2d" })).toBe('{"a":"\\u4e2d"}'.length);
    expect(preferencesSize({ a: "😀" })).toBe('{"a":"\\ud83d\\ude00"}'.length);
  });

  it("sets, removes and rejects without changing the input", () => {
    const prefs = Object.freeze({ theme: "dark" });
    expect(applyPreference(prefs, "width", 280)).toEqual({ ok: true, prefs: { theme: "dark", width: 280 } });
    expect(applyPreference(prefs, "theme", null)).toEqual({ ok: true, prefs: {} });
    expect(applyPreference(prefs, "missing", null)).toEqual({ ok: true, prefs: { theme: "dark" } });
    expect(applyPreference(prefs, "bad key", 1)).toEqual({ ok: false, reason: "invalid-key" });
    expect(applyPreference(prefs, "theme", { nested: true })).toEqual({ ok: false, reason: "invalid-value" });
    expect(applyPreference(prefs, "theme", undefined)).toEqual({ ok: false, reason: "invalid-value" });
  });

  it("bounds the total, so every preference fits one request header", () => {
    let prefs = {};
    const reasons: string[] = [];
    for (let i = 0; i < 10; i++) {
      const applied = applyPreference(prefs, `key${i}`, "\u4e2d".repeat(100));
      if (applied.ok) prefs = applied.prefs;
      else reasons.push(applied.reason);
    }
    expect(reasons.length).toBeGreaterThan(0);
    expect(new Set(reasons)).toEqual(new Set(["too-large"]));
    expect(preferencesSize(prefs)).toBeLessThanOrEqual(PREFERENCE_LIMITS.totalBytes);
    // Removing always works, even at the limit.
    expect(applyPreference(prefs, "key0", null).ok).toBe(true);
  });

  it("encodes cookie values compactly, escaping only what a cookie value cannot hold", () => {
    expect(preferenceCookieValue("dark")).toBe("%22dark%22");
    expect(preferenceCookieValue("a=b/c:d")).toBe("%22a=b/c:d%22");
    expect(preferenceCookieValue("x; y,z\\%")).toBe("%22x%3B%20y%2Cz%5C%5C%25%22");
    expect(preferenceCookieValue("\u4e2d")).toBe("%22%E4%B8%AD%22");
    expect(preferenceCookieValue(280)).toBe("280");
    expect(preferenceCookieValue(false)).toBe("false");
    for (const value of ["\u4e2d\u6587😀", '"quoted"', "a%20b", "x; y", 1.5, true])
      expect(preferencesFromCookies(`${PREFERENCE_COOKIE_PREFIX}k=${preferenceCookieValue(value)}`)).toEqual({
        k: value,
      });
  });

  it("measures the application-prefixed cookies the way a Cookie header carries them", () => {
    expect(preferenceCookiesSize({})).toBe(0);
    expect(preferenceCookiesSize({ theme: "dark" })).toBe(`${PREFERENCE_COOKIE_PREFIX}theme=%22dark%22`.length);
    expect(preferenceCookiesSize({ a: 1, b: true })).toBe(
      `${PREFERENCE_COOKIE_PREFIX}a=1; ${PREFERENCE_COOKIE_PREFIX}b=true`.length,
    );
  });

  it("includes the application prefix when accepting the exact cookie budget and rejecting one more byte", () => {
    const overhead = `${PREFERENCE_COOKIE_PREFIX}k=`.length + 6; // Encoded opening and closing quotes.
    const payloadBytes = PREFERENCE_LIMITS.totalBytes - overhead;
    const value = "主".repeat(Math.floor(payloadBytes / 9)) + "x".repeat(payloadBytes % 9);
    const cookie = `${PREFERENCE_COOKIE_PREFIX}k=${encodeURIComponent(JSON.stringify(value))}`;
    expect(new TextEncoder().encode(cookie)).toHaveLength(PREFERENCE_LIMITS.totalBytes);
    expect(preferencesSize({ k: value })).toBeLessThan(PREFERENCE_LIMITS.totalBytes);
    expect(preferenceCookiesSize({ k: value })).toBe(PREFERENCE_LIMITS.totalBytes);
    expect(applyPreference({}, "k", value)).toEqual({ ok: true, prefs: { k: value } });
    expect(preferencesFromCookies(cookie)).toEqual({ k: value });
    expect(applyPreference({}, "k", `${value}x`)).toEqual({ ok: false, reason: "too-large" });
  });

  it("counts each prefix and separator in a multi-cookie header", () => {
    const prefs = { first: "x".repeat(1000), second: "主".repeat(200), third: true };
    const header = Object.entries(prefs)
      .map(([key, value]) => `${PREFERENCE_COOKIE_PREFIX}${key}=${encodeURIComponent(JSON.stringify(value))}`)
      .join("; ");
    expect(preferenceCookiesSize(prefs)).toBe(new TextEncoder().encode(header).length);
    expect(preferencesFromCookies(header)).toEqual(prefs);
  });

  it("ignores legacy and other applications' preference cookies", () => {
    // Explicit legacy fixture: no compatibility layer reads the former unscoped cookie name.
    expect(preferencesFromCookies("pref-theme=%22dark%22; another-app_pref_theme=%22dark%22")).toEqual({});
    expect(preferencesFromCookies(`pref-theme=%22dark%22; ${PREFERENCE_COOKIE_PREFIX}theme=%22light%22`)).toEqual({
      theme: "light",
    });
  });

  it("rejects values whose cookies would exceed the budget, even when the header would fit", () => {
    // 600 CJK characters fit the ASCII JSON budget, but their encoded cookie exceeds 4 KiB.
    expect(applyPreference({}, "k", "\u4e3b".repeat(600))).toEqual({ ok: false, reason: "too-large" });
    // 1024 quotes fit as JSON but exceed the cookie budget (`\"` becomes `%5C%22`).
    expect(applyPreference({}, "k", '"'.repeat(1024))).toEqual({ ok: false, reason: "too-large" });
    expect(applyPreference({}, "k", "\u4e3b".repeat(400)).ok).toBe(true);
    // Many medium values: 11 keys of 60 CJK characters would be about 6 KB of Cookie header.
    let prefs = {};
    const results: boolean[] = [];
    for (let i = 0; i < 11; i++) {
      const applied = applyPreference(prefs, `key${i}`, "\u4e2d".repeat(60));
      results.push(applied.ok);
      if (applied.ok) prefs = applied.prefs;
    }
    expect(results).toContain(false);
    expect(preferenceCookiesSize(prefs)).toBeLessThanOrEqual(PREFERENCE_LIMITS.totalBytes);
  });

  it("sanitizes untrusted objects", () => {
    expect(sanitizePreferences(null)).toEqual({});
    expect(sanitizePreferences([1])).toEqual({});
    expect(sanitizePreferences("x")).toEqual({});
    const parsed: unknown = JSON.parse('{"theme":"dark","__proto__":{"x":1},"bad key":1,"n":null,"o":{},"w":280}');
    const prefs = sanitizePreferences(parsed);
    expect(prefs).toEqual({ theme: "dark", w: 280 });
    expect(Object.getPrototypeOf(prefs)).toBe(Object.prototype);
    const big = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "x".repeat(400)]));
    expect(preferencesSize(sanitizePreferences(big))).toBeLessThanOrEqual(PREFERENCE_LIMITS.totalBytes);
  });

  it("round-trips through application-prefixed cookies, keeping types", () => {
    const cookie = [
      `${PREFERENCE_COOKIE_PREFIX}theme=${preferenceCookieValue("dark; mode=1")}`,
      `${PREFERENCE_COOKIE_PREFIX}width=${preferenceCookieValue(280)}`,
      `${PREFERENCE_COOKIE_PREFIX}compact=${preferenceCookieValue(true)}`,
      `${PREFERENCE_COOKIE_PREFIX}locale=${preferenceCookieValue("\u4e2d\u6587")}`,
      "session=abc",
      `${PREFERENCE_COOKIE_PREFIX}broken=%7B`,
      `${PREFERENCE_COOKIE_PREFIX}bad%20key=1`,
      `${PREFERENCE_COOKIE_PREFIX}raw=dark`,
    ].join("; ");
    expect(preferencesFromCookies(cookie)).toEqual({
      theme: "dark; mode=1",
      width: 280,
      compact: true,
      locale: "\u4e2d\u6587",
    });
    expect(preferencesFromCookies(undefined)).toEqual({});
    // The same name twice (different paths): the first, most specific one wins.
    expect(
      preferencesFromCookies(
        `${PREFERENCE_COOKIE_PREFIX}theme=%22dark%22; ${PREFERENCE_COOKIE_PREFIX}theme=%22light%22`,
      ),
    ).toEqual({ theme: "dark" });
    expect(preferencesFromCookies("")).toEqual({});
  });
});
