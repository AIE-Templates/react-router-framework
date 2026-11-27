import { STORE_TIMEOUT_MS, type CookieJar, type CookieStore } from "@repo/electron-cookies/main";
import { serializeVisualCookie, visualCookie } from "@repo/shared";

import { VISUAL_COOKIE_FAILED_MESSAGE } from "~/startup-signals.ts";

import { APP_ORIGIN, COOKIE_JAR_ORIGIN } from "./app-url.ts";
import type { BootProfile } from "./boot-profile.ts";
import type { Logger } from "./log.ts";

/** Allow time to answer an OS credential prompt before the first document's request deadline starts. */
export const COOKIE_STORE_STARTUP_TIMEOUT_MS = 3 * 60_000;

// A restarted network service answers new reads. Two seconds bounds a full prompt wait to 90 reads.
export const COOKIE_STORE_PROBE_INTERVAL_MS = 2_000;

type StartupCookies = Awaited<ReturnType<CookieStore["get"]>>;

export async function syncFirstVisualCookie(
  cookies: StartupCookies,
  raw: string | null,
  script: Pick<CookieJar["script"], "writeText">,
  log: Pick<Logger, "warn">,
) {
  if (raw === null) return;
  const current = cookies.find((cookie) => cookie.name === visualCookie.name && !cookie.httpOnly);
  if (current?.value === encodeURIComponent(raw)) return;
  // The page sees app:, even though the session stores its cookies at a private HTTPS origin.
  const text = serializeVisualCookie(raw, false);
  try {
    const result = await script.writeText(APP_ORIGIN + "/", text, AbortSignal.timeout(STORE_TIMEOUT_MS));
    if (result.status === "stored") return;
  } catch {
    // The first document can still paint from the preload sample.
  }
  log.warn({}, VISUAL_COOKIE_FAILED_MESSAGE);
}

export async function openFirstWindow<T>(
  store: Pick<CookieStore, "get">,
  log: Pick<Logger, "warn">,
  profile: BootProfile,
  open: () => T,
  prepare?: (cookies: StartupCookies) => Promise<void>,
): Promise<T> {
  const start = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setInterval> | undefined;
  let cookies: StartupCookies | undefined;
  try {
    cookies = await new Promise<StartupCookies | undefined>((resolve, reject) => {
      timer = setTimeout(() => {
        log.warn({ timeoutMs: COOKIE_STORE_STARTUP_TIMEOUT_MS }, "cookie store timed out before first window");
        resolve(undefined);
      }, COOKIE_STORE_STARTUP_TIMEOUT_MS);
      // Reads for this host share Chromium's pending store and key initialization.
      const probe = async () => {
        try {
          resolve(await store.get({ url: COOKIE_JAR_ORIGIN }));
        } catch (error) {
          reject(error);
        }
      };
      retry = setInterval(() => void probe(), COOKIE_STORE_PROBE_INTERVAL_MS);
      void probe();
    });
  } catch {
    log.warn({ operation: "cookies.get" }, "cookie store read failed before first window");
  } finally {
    clearInterval(retry);
    clearTimeout(timer);
    profile.note("cookie-store-wait-ms", Math.round(performance.now() - start));
  }
  if (cookies && prepare) await prepare(cookies);
  return open();
}
