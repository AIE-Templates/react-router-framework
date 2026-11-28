import type { CookieStore } from "@electron-webhost/cookies/main";
import { vi } from "vitest";

type Stored = Parameters<CookieStore["set"]>[0];

/**
 * A fake of Electron's cookie store for tests: path matching, expiry and the HttpOnly overwrite rule
 * the way `session.cookies` behaves (pinned against the real store in e2e/storage.spec.ts).
 */
export function fakeCookieStore() {
  const cookies: Stored[] = [];
  /** The persistent cookies as of the last `flushStore()`: what a relaunch after a hard kill loads. */
  const disk: Stored[] = [];
  return {
    cookies,
    disk,
    get: vi.fn<CookieStore["get"]>(async ({ url }) => {
      const path = url && new URL(url).pathname;
      return cookies
        .filter(
          (c) =>
            (c.expirationDate === undefined || c.expirationDate * 1000 > Date.now()) &&
            (!path || path === c.path || path.startsWith(c.path.endsWith("/") ? c.path : c.path + "/")),
        )
        .map((c) => ({ ...c, domain: c.domain ? "." + c.domain : new URL(c.url).hostname, hostOnly: !c.domain }))
        .toSorted((a, b) => b.path.length - a.path.length);
    }),
    set: vi.fn<CookieStore["set"]>(async (input) => {
      const details = { ...input, path: input.path || new URL(input.url).pathname.replace(/\/[^/]*$/, "") || "/" };
      const at = cookies.findIndex(
        (c) => c.name === details.name && c.path === details.path && c.domain === details.domain,
      );
      // Chromium (through Electron's `set`) does not let a non-HttpOnly cookie replace an HttpOnly one.
      if (at >= 0 && cookies[at].httpOnly && !details.httpOnly) throw new Error("EXCLUDE_OVERWRITE_HTTP_ONLY");
      if (at >= 0) cookies.splice(at, 1);
      if (details.expirationDate === undefined || details.expirationDate * 1000 > Date.now()) cookies.push(details);
    }),
    flushStore: vi.fn<CookieStore["flushStore"]>(async () => {
      disk.splice(0, disk.length, ...cookies.filter((c) => c.expirationDate !== undefined));
    }),
  } satisfies CookieStore & { cookies: Stored[]; disk: Stored[] };
}
