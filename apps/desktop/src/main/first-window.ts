import type { CookieStore } from "@repo/electron-cookies/main";

import { COOKIE_JAR_ORIGIN } from "./app-url.ts";
import type { BootProfile } from "./boot-profile.ts";
import type { Logger } from "./log.ts";

/** Allow time to answer an OS credential prompt before the first document's request deadline starts. */
export const COOKIE_STORE_STARTUP_TIMEOUT_MS = 3 * 60_000;

export async function openFirstWindow<T>(
  store: Pick<CookieStore, "get">,
  log: Pick<Logger, "warn">,
  profile: BootProfile,
  open: () => T,
): Promise<T> {
  const start = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log.warn({ timeoutMs: COOKIE_STORE_STARTUP_TIMEOUT_MS }, "cookie store timed out before first window");
      resolve();
    }, COOKIE_STORE_STARTUP_TIMEOUT_MS);
  });
  try {
    // Chromium loads this host's persistent cookies after initializing the store's encryption key.
    await Promise.race([store.get({ url: COOKIE_JAR_ORIGIN }), timeout]);
  } catch {
    log.warn({ operation: "cookies.get" }, "cookie store read failed before first window");
  } finally {
    clearTimeout(timer);
    profile.note("cookie-store-wait-ms", Math.round(performance.now() - start));
  }
  return open();
}
