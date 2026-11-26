import type { CookieStore } from "@repo/electron-cookies/main";

import { COOKIE_JAR_ORIGIN } from "./app-url.ts";
import type { BootProfile } from "./boot-profile.ts";
import type { Logger } from "./log.ts";

/** Allow time to answer an OS credential prompt before the first document's request deadline starts. */
export const COOKIE_STORE_STARTUP_TIMEOUT_MS = 3 * 60_000;

// A restarted network service answers new reads. Two seconds bounds a full prompt wait to 90 reads.
export const COOKIE_STORE_PROBE_INTERVAL_MS = 2_000;

export async function openFirstWindow<T>(
  store: Pick<CookieStore, "get">,
  log: Pick<Logger, "warn">,
  profile: BootProfile,
  open: () => T,
): Promise<T> {
  const start = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setInterval> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        log.warn({ timeoutMs: COOKIE_STORE_STARTUP_TIMEOUT_MS }, "cookie store timed out before first window");
        resolve();
      }, COOKIE_STORE_STARTUP_TIMEOUT_MS);
      // Reads for this host share Chromium's pending store and key initialization.
      const probe = async () => {
        try {
          await store.get({ url: COOKIE_JAR_ORIGIN });
          resolve();
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
  return open();
}
