// Electron layer: host request and preference protocol.
import type { DesktopPrefs } from "./desktop-headers.ts";

/**
 * Small user preferences that client code writes and server rendering reads (theme, locale, sidebar
 * width). The web shell keeps each one in a `pref-<key>` cookie; the desktop shell, which has no
 * cookies under `app://`, keeps them in the main process and sends them as `x-desktop-prefs`. Both
 * shells apply the same rules, so a key that works in one works in the other.
 */
export type PreferenceValue = string | number | boolean;

export const PREFERENCE_LIMITS = {
  /** Key length: a letter, then letters, digits, `_`, `.` or `-` (cookie-name safe in the web shell). */
  keyLength: 64,
  /** String value length, in UTF-16 code units. */
  stringLength: 1024,
  /**
   * All preferences together, measured both ways they travel, each at most this: as ASCII JSON
   * (non-ASCII characters count as their 6-byte `\uXXXX` escape), the `x-desktop-prefs` header; and
   * as the web shell's `pref-*` cookies (`preferenceCookiesSize()`: names, `=`, encoded values and
   * the `; ` between them). Both bounds apply in both shells, so the shells accept the same values.
   * 4 KiB keeps every single cookie within what browsers store (Chromium silently drops a cookie
   * whose name and value exceed 4096 bytes) and the preferences' share of a request's headers far
   * below the 8 KiB some proxies allow in total.
   */
  totalBytes: 4096,
} as const;

/** Prefix of the web shell's preference cookies: `theme` is stored as `pref-theme`. */
export const PREFERENCE_COOKIE_PREFIX = "pref-";

/** IPC channels between the desktop preload and the main process. */
export const DESKTOP_PREFS_IPC = {
  /** Renderer → main (invoke): `{ key, value }`, `value: null` removes; answers a `PreferenceUpdateResult`. */
  set: "desktop:prefs:set",
} as const;

export type PreferenceRejection = "invalid-key" | "invalid-value" | "too-large";

export type PreferenceUpdateResult = { status: "applied" } | { status: "rejected"; reason: string };

const KEY = new RegExp(`^[A-Za-z][\\w.-]{0,${PREFERENCE_LIMITS.keyLength - 1}}$`);

export function isPreferenceKey(key: unknown): key is string {
  return typeof key === "string" && KEY.test(key);
}

export function isPreferenceValue(value: unknown): value is PreferenceValue {
  return (
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length <= PREFERENCE_LIMITS.stringLength)
  );
}

/** The byte length of `prefs` as ASCII JSON, the form `x-desktop-prefs` carries. */
export function preferencesSize(prefs: DesktopPrefs): number {
  const json = JSON.stringify(prefs);
  let size = json.length;
  for (let i = 0; i < json.length; i++) if (json.charCodeAt(i) > 0x7e) size += 5;
  return size;
}

/**
 * `prefs` with `key` set to `value` (or removed, for `null`), checked against the limits. Never
 * changes `prefs`.
 */
export function applyPreference(
  prefs: DesktopPrefs,
  key: unknown,
  value: unknown,
): { ok: true; prefs: DesktopPrefs } | { ok: false; reason: PreferenceRejection } {
  if (!isPreferenceKey(key)) return { ok: false, reason: "invalid-key" };
  if (value !== null && !isPreferenceValue(value)) return { ok: false, reason: "invalid-value" };
  const next: DesktopPrefs = { ...prefs };
  if (value === null) delete next[key];
  else next[key] = value;
  if (
    value !== null &&
    (preferencesSize(next) > PREFERENCE_LIMITS.totalBytes || preferenceCookiesSize(next) > PREFERENCE_LIMITS.totalBytes)
  )
    return { ok: false, reason: "too-large" };
  return { ok: true, prefs: next };
}

/**
 * The valid preferences of an untrusted object (a file, a header): entries with a bad key or value
 * are dropped, and so is every entry that would take the total past `PREFERENCE_LIMITS.totalBytes`.
 */
export function sanitizePreferences(value: unknown): DesktopPrefs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  let prefs: DesktopPrefs = {};
  for (const [key, item] of Object.entries(value)) {
    const applied = applyPreference(prefs, key, item === null ? undefined : item);
    if (applied.ok) prefs = applied.prefs;
  }
  return prefs;
}

/**
 * The web shell's preferences from a `Cookie` header (or `document.cookie`): `pref-*` cookies, JSON
 * values. When a name repeats (same name, different paths), the first wins: browsers send the most
 * specific path first.
 */
export function preferencesFromCookies(cookie: string | null | undefined): DesktopPrefs {
  const found: Record<string, unknown> = {};
  for (const pair of (cookie ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at < 0) continue;
    const name = pair.slice(0, at).trim();
    if (!name.startsWith(PREFERENCE_COOKIE_PREFIX)) continue;
    const key = name.slice(PREFERENCE_COOKIE_PREFIX.length);
    if (Object.hasOwn(found, key)) continue;
    try {
      found[key] = JSON.parse(decodeURIComponent(pair.slice(at + 1).trim()));
    } catch {
      // Not one of ours: skip it.
    }
  }
  return sanitizePreferences(found);
}

/** What a cookie value may not hold as is (RFC 6265 cookie-octet), plus `%`, the escape itself. */
const COOKIE_UNSAFE = /[^\x21\x23\x24\x26-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]/gu;

/**
 * The cookie value for a preference: its JSON, so strings, numbers and booleans keep their type,
 * with only what a cookie value cannot hold percent-encoded (quotes, `;`, `,`, `\`, spaces, `%`,
 * controls and non-ASCII as UTF-8), so `decodeURIComponent` reverses it. A CJK character costs 9
 * bytes, a `"` inside a string 6 (`\"` → `%5C%22`).
 */
export function preferenceCookieValue(value: PreferenceValue): string {
  return JSON.stringify(value).replace(COOKIE_UNSAFE, (c) => encodeURIComponent(c));
}

/** The bytes `prefs` take as `pref-*` cookies in a `Cookie` header: `name=value` pairs joined by `; `. */
export function preferenceCookiesSize(prefs: DesktopPrefs): number {
  let size = 0;
  let count = 0;
  for (const [key, value] of Object.entries(prefs)) {
    size += PREFERENCE_COOKIE_PREFIX.length + key.length + 1 + preferenceCookieValue(value).length;
    count++;
  }
  return size + Math.max(0, count - 1) * 2;
}
