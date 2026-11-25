import { vi } from "vitest";

import type { CookieStore } from "../store.ts";

type Stored = Parameters<CookieStore["set"]>[0];

/**
 * A fake of Electron's cookie store for tests: path matching, expiry and the HttpOnly overwrite rule
 * the way `session.cookies` behaves for the server entry points.
 */
export function fakeCookieStore() {
  const cookies: Stored[] = [];
  /** The persistent cookies as of the last `flushStore()`: what a relaunch after a hard kill loads. */
  const disk: Stored[] = [];
  return {
    cookies,
    disk,
    get: vi.fn<CookieStore["get"]>(async ({ url, httpOnly }) => {
      const path = new URL(url).pathname;
      return cookies
        .filter(
          (c) =>
            (httpOnly === undefined || c.httpOnly === httpOnly) &&
            (c.expirationDate === undefined || c.expirationDate * 1000 > Date.now()) &&
            (path === c.path || path.startsWith(c.path.endsWith("/") ? c.path : c.path + "/")),
        )
        .map((c) => ({
          ...c,
          hostOnly: c.domain === undefined,
          domain: c.domain ? "." + c.domain : new URL(c.url).hostname,
        }))
        .toSorted((a, b) => b.path.length - a.path.length);
    }),
    set: vi.fn<CookieStore["set"]>(async (details) => {
      const at = cookies.findIndex(
        (c) => c.name === details.name && c.path === details.path && c.domain === details.domain,
      );
      // Chromium (through Electron's `set`) does not let a non-HttpOnly cookie replace an HttpOnly one.
      if (at >= 0 && cookies[at].httpOnly && !details.httpOnly) throw new Error("EXCLUDE_OVERWRITE_HTTP_ONLY");
      const lower = details.name.toLowerCase();
      if (
        Buffer.byteLength(details.name + details.value) > 4096 ||
        (!details.name && !details.value) ||
        (details.domain !== undefined && details.domain !== new URL(details.url).hostname) ||
        (lower.startsWith("__host-") && (details.path !== "/" || details.domain !== undefined || !details.secure)) ||
        (lower.startsWith("__secure-") && !details.secure) ||
        (lower.startsWith("__http-") && (!details.secure || !details.httpOnly)) ||
        (details.sameSite === "no_restriction" && !details.secure)
      )
        throw new Error("excluded");
      if (at >= 0) cookies.splice(at, 1);
      if (details.expirationDate === undefined || details.expirationDate * 1000 > Date.now()) cookies.push(details);
    }),
    flushStore: vi.fn<CookieStore["flushStore"]>(async () => {
      disk.splice(0, disk.length, ...cookies.filter((c) => c.expirationDate !== undefined));
    }),
  } satisfies CookieStore & { cookies: Stored[]; disk: Stored[] };
}
