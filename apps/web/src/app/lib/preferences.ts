import {
  applyPreference,
  type DesktopBridge,
  PREFERENCE_COOKIE_PREFIX,
  preferenceCookieValue,
  preferencesFromCookies,
  type PreferenceValue,
  type Shell,
} from "@repo/shared";
import { useCallback } from "react";
import { createContext, type RouterContextProvider, useRevalidator } from "react-router";

import { useAppEnvironment } from "~/providers/environment";

export type { PreferenceValue };

/**
 * Small user preferences that client code writes and server rendering reads (theme, locale, sidebar
 * width), the same in both shells. The web shell keeps them in `pref-<key>` cookies; the desktop
 * shell has no cookies under `app://`, so its main process keeps them and sends them with every
 * request as `x-desktop-prefs`. Read them in loaders and actions with `getPreference()`, write them
 * from components with `useSetPreference()`; never through `document.cookie` directly, which the
 * desktop shell drops. Keys and values follow `PREFERENCE_LIMITS` from `@repo/shared`. Reading is
 * server-side only: SPA builds and `clientLoader`s have no read path (HOST-08).
 */
export type Preferences = Readonly<Record<string, PreferenceValue>>;

/**
 * This request's preferences, set by the host from the shell it was started with: the `pref-*`
 * cookies in the web shell, the parsed `x-desktop-prefs` header in the desktop shell. Read them with
 * `getPreference()`.
 */
export const preferencesContext = createContext<Preferences>({});

/** The host's half: this request's preferences, by the shell the entry point gave (never the request). */
export function requestPreferences(shell: Shell, request: Request, desktop?: { prefs: Preferences }): Preferences {
  return shell.kind === "desktop" ? (desktop?.prefs ?? {}) : preferencesFromCookies(request.headers.get("cookie"));
}

/** A preference in a loader or action, or `undefined` when unset (or invalid, which is dropped). */
export function getPreference(context: Readonly<RouterContextProvider>, key: string): PreferenceValue | undefined {
  const preferences = context.get(preferencesContext);
  return Object.hasOwn(preferences, key) ? preferences[key] : undefined;
}

/** A write the shell refused: a bad key or value, too much in total, or a failed desktop bridge. */
export class PreferenceError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`preference not saved: ${reason}`);
    this.name = "PreferenceError";
    this.reason = reason;
  }
}

/** One year: preferences outlive sessions. */
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;

/**
 * Writes a preference (or removes it, for `null`) without revalidating: for code outside React, such
 * as a `clientAction` (React Router revalidates after it anyway). Components use `useSetPreference()`.
 * Throws a `PreferenceError` when the value is not stored. `shell` is the environment's shell
 * (`useAppEnvironment().shell.kind`, or `<html data-shell>`), never something from a request.
 */
export async function writePreference(
  shell: Shell["kind"],
  key: string,
  value: PreferenceValue | null,
  {
    bridge = globalThis.window?.desktop,
    doc = globalThis.document,
  }: { bridge?: DesktopBridge; doc?: { cookie: string; location?: { protocol: string } | null } } = {},
): Promise<void> {
  if (shell === "desktop") {
    if (typeof bridge?.setPref !== "function" || typeof bridge.removePref !== "function")
      throw new PreferenceError("bridge-unavailable");
    const result = value === null ? await bridge.removePref(key) : await bridge.setPref(key, value);
    if (result.status !== "applied") throw new PreferenceError(result.reason);
    return;
  }
  if (!doc) throw new PreferenceError("no-document");
  // The same limits as the desktop shell, over the preferences this browser already holds.
  const applied = applyPreference(preferencesFromCookies(doc.cookie), key, value);
  if (!applied.ok) throw new PreferenceError(applied.reason);
  const attributes = ["Path=/", "SameSite=Lax", `Max-Age=${value === null ? 0 : COOKIE_MAX_AGE_S}`];
  if (doc.location?.protocol === "https:") attributes.push("Secure");
  const cookieValue = value === null ? "" : preferenceCookieValue(value);
  doc.cookie = [`${PREFERENCE_COOKIE_PREFIX}${key}=${cookieValue}`, ...attributes].join("; ");
}

/**
 * `setPreference(key, value)` for components: writes the preference in this shell's store (`null`
 * removes it), then revalidates, so loaders that read it with `getPreference()` see the new value.
 * Rejects with a `PreferenceError` when the value is not stored.
 */
export function useSetPreference(): (key: string, value: PreferenceValue | null) => Promise<void> {
  const { shell } = useAppEnvironment();
  const { revalidate } = useRevalidator();
  return useCallback(
    async (key, value) => {
      await writePreference(shell.kind, key, value);
      await revalidate();
    },
    [shell.kind, revalidate],
  );
}
