import type { Cookie } from "electron";

import { parseSetCookie, type JarCookie } from "./parse.ts";
import type { WindowCookie } from "./shared.ts";
import {
  abandonOn,
  type observeStore,
  orderCookies,
  serializeCookies,
  toCookieWrite,
  writeCookie,
  type WriteResult,
} from "./store.ts";

// oxlint-disable-next-line no-control-regex -- A normalized Cookie Store field may contain neither ASCII controls nor semicolons.
const invalidData = /[;\x00-\x1f\x7f]/;
const malformed = "Cookie was malformed and could not be stored, due to problem(s) while parsing.";

// The preload has already performed Web IDL conversion. Validate the wire data independently
// and construct only non-HttpOnly writes, even when the renderer supplies extra fields.
function structuredCookie(input: unknown, host: string): JarCookie {
  if (!input || typeof input !== "object") throw new TypeError(malformed);
  const { name, value, path, expires, domain, sameSite, secure, partitioned } = input as Partial<WindowCookie>;
  if (
    typeof name !== "string" ||
    typeof value !== "string" ||
    typeof path !== "string" ||
    !path.startsWith("/") ||
    (domain !== null && domain !== host) ||
    secure !== true ||
    partitioned !== false ||
    (expires !== null && (typeof expires !== "number" || !Number.isFinite(expires))) ||
    (sameSite !== "strict" && sameSite !== "lax" && sameSite !== "none") ||
    invalidData.test(name) ||
    invalidData.test(value) ||
    Buffer.byteLength(name + value) > 4096 ||
    /^__(?:host-)?http-/i.test(name) ||
    (/^__host-/i.test(name) && (domain !== null || path !== "/")) ||
    (!name && /^__(?:secure|host|http)-/i.test(value)) ||
    name.includes("=") ||
    (!name && (!value || value.includes("=")))
  )
    throw new TypeError(malformed);
  return {
    name,
    value,
    path,
    domain: domain ?? undefined,
    expirationDate: expires === null ? undefined : expires <= 0 ? 1 : expires / 1000,
    secure: true,
    httpOnly: false,
    sameSite: sameSite === "none" ? "no_restriction" : sameSite,
  };
}

export function createScriptCookies(
  store: ReturnType<typeof observeStore>,
  origin: string,
  host: string,
  storageOrigin: string,
  storageHost: string,
) {
  async function read(url: string, signal: AbortSignal) {
    const cookies = await abandonOn(store.get({ url: storageOrigin + new URL(url).pathname, httpOnly: false }), signal);
    return orderCookies(cookies.filter((cookie) => !cookie.httpOnly));
  }

  function publicCookie(cookie: Cookie): WindowCookie {
    return {
      name: cookie.name,
      value: cookie.value,
      path: cookie.path ?? "/",
      domain: (cookie.hostOnly ?? !cookie.domain?.startsWith(".")) ? null : host,
      expires: cookie.expirationDate === undefined ? null : cookie.expirationDate * 1000,
      sameSite: cookie.sameSite === "strict" ? "strict" : cookie.sameSite === "no_restriction" ? "none" : "lax",
      secure: cookie.secure === true,
      partitioned: false,
    };
  }

  function write(cookie: JarCookie, signal: AbortSignal) {
    return writeCookie(store, toCookieWrite(cookie, storageOrigin, storageHost, host), signal);
  }

  return {
    get successfulStoreCalls() {
      return store.successes;
    },
    origin,
    storageHost,
    publicCookie,
    async readText(url: string, signal: AbortSignal) {
      return serializeCookies(await read(url, signal));
    },
    async readAll(url: string, name: string | undefined, signal: AbortSignal) {
      return (await read(url, signal)).filter((cookie) => name === undefined || cookie.name === name).map(publicCookie);
    },
    async writeText(url: string, text: string, signal: AbortSignal): Promise<WriteResult> {
      const parsed = parseSetCookie(text, { requestPath: new URL(url).pathname, now: Date.now() });
      if (!parsed.ok || parsed.cookie.httpOnly || (parsed.cookie.domain !== undefined && parsed.cookie.domain !== host))
        return { status: "rejected", reason: "invalid script cookie" };
      return write(parsed.cookie, signal);
    },
    async writeStructured(input: unknown, signal: AbortSignal) {
      const result = await write(structuredCookie(input, host), signal);
      if (result.status === "rejected") throw new TypeError(malformed);
      if (result.status === "unknown") throw signal.reason;
    },
  };
}

export type ScriptCookies = ReturnType<typeof createScriptCookies>;
