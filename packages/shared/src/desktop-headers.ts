// Electron layer: host request and preference protocol.
import type { ChromeMode } from "./window-chrome.ts";

/**
 * Request headers the desktop shell's main process sets on each request it forwards, for facts that
 * change while the app runs. Only the desktop entry trusts them; the web entry removes every header
 * with this prefix before routing, so a browser cannot claim to be the desktop app.
 */
export const DESKTOP_HEADER_PREFIX = "x-desktop-";

export const DESKTOP_HEADERS = {
  /** `native` or `custom`: whether the window draws its own title bar. */
  titlebar: `${DESKTOP_HEADER_PREFIX}titlebar`,
  /** The resolved window chrome mode, independent of the legacy titlebar hint. */
  chromeMode: `${DESKTOP_HEADER_PREFIX}chrome-mode`,
  /** `1` while the window is full screen, `0` otherwise. */
  fullscreen: `${DESKTOP_HEADER_PREFIX}fullscreen`,
  /** A JSON object of string, number or boolean preferences, e.g. `{"theme":"dark","sidebarWidth":280}`. */
  prefs: `${DESKTOP_HEADER_PREFIX}prefs`,
} as const;

export type DesktopPrefs = Record<string, string | number | boolean>;

/** The per-request desktop facts, parsed from the `x-desktop-*` headers. */
export interface DesktopRequest {
  titlebar: "native" | "custom";
  chromeMode: ChromeMode;
  fullscreen: boolean;
  prefs: DesktopPrefs;
}

/**
 * Reads the `x-desktop-*` headers, falling back to defaults (`native`, not full screen, no
 * preferences) for missing or malformed values. Never throws; preferences that are not strings,
 * finite numbers or booleans are dropped.
 */
export function parseDesktopHeaders(headers: Headers): DesktopRequest {
  return {
    titlebar: headers.get(DESKTOP_HEADERS.titlebar)?.trim() === "custom" ? "custom" : "native",
    chromeMode:
      headers.get(DESKTOP_HEADERS.chromeMode)?.trim() === "native-overlay" ? "native-overlay" : "system-decorated",
    fullscreen: headers.get(DESKTOP_HEADERS.fullscreen)?.trim() === "1",
    prefs: parsePrefs(headers.get(DESKTOP_HEADERS.prefs)),
  };
}

function parsePrefs(value: string | null): DesktopPrefs {
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const prefs: DesktopPrefs = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) {
      prefs[key] = item;
    }
  }
  return prefs;
}

/** Whether `name` is one of the desktop headers (any `x-desktop-*` header, case-insensitively). */
export function isDesktopHeader(name: string): boolean {
  return name.toLowerCase().startsWith(DESKTOP_HEADER_PREFIX);
}
