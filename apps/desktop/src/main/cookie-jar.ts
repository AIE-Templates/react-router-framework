/**
 * The server's cookies under `app://app`, kept by the main process.
 *
 * Chromium keeps no cookies for `app://` (not a cookieable scheme, electron/electron#27981), and a
 * `protocol.handle` response bypasses the network service's cookie handling whatever the scheme, so
 * the browser would drop every `Set-Cookie` and never send a `Cookie`. The `app://` handler instead
 * reads `Set-Cookie` off each upstream response, stores the cookies in the app session's cookie store
 * under `COOKIE_JAR_ORIGIN` (encrypted at rest when the `EnableCookieEncryption` fuse is on), and
 * sends them back as a `Cookie` header on later requests. Spec: HOST-09.
 *
 * Parsing and serialization here are pure (RFC 6265bis, section 5.6 and 5.7); `createCookieJar()` is
 * the thin adapter over a store shaped like Electron's `Cookies`.
 */

/**
 * The URL the cookies are stored under. https, so `Secure` cookies are accepted (Chromium refuses a
 * Secure cookie for an http URL), and the internal origin's host (`INTERNAL_ORIGIN` is
 * `http://app.desktop`), so the server's view of its own host and the jar's agree. Nothing in the
 * session ever requests this origin over the network: windows only load `app://app`, `.desktop` is
 * not a delegated top-level domain, and the CSP's `connect-src` does not list it.
 */
export const COOKIE_JAR_ORIGIN = "https://app.desktop";

/** Name plus value, in bytes (RFC 6265bis 5.6, step 4). */
export const MAX_NAME_VALUE_BYTES = 4096;
/** Longer attribute values are ignored (RFC 6265bis 5.6, step 7). */
export const MAX_ATTRIBUTE_VALUE_BYTES = 1024;
/** `Expires` and `Max-Age` are capped at 400 days (RFC 6265bis 5.6.1, 5.6.2). */
export const MAX_AGE_S = 400 * 24 * 60 * 60;
/** `Set-Cookie` headers handled per response; the rest are ignored. */
export const MAX_SET_COOKIES_PER_RESPONSE = 50;

/** `sameSite` as Electron's cookie store spells it. */
export type SameSite = "unspecified" | "no_restriction" | "lax" | "strict";

export interface JarCookie {
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite;
  /** Seconds since the epoch; absent for a session cookie. */
  expirationDate?: number;
}

/** What one `Set-Cookie` asks for: store a cookie, or delete one (expired: past Expires, Max-Age ≤ 0). */
export type CookieChange = { kind: "set"; cookie: JarCookie } | { kind: "delete"; name: string; path: string };

export type ParsedSetCookie = { ok: true; change: CookieChange } | { ok: false; reason: string };

export interface ParseContext {
  /** The request's path (no query), for the default cookie path. */
  requestPath: string;
  /** Hosts a `Domain` attribute may name; it then still makes a host-only cookie. */
  hosts: readonly string[];
  /** Milliseconds since the epoch. */
  now: number;
}

// CTLs except HTAB (RFC 6265bis 5.6, step 1).
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;
const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;

/** Parses one `Set-Cookie` value. Never throws; a cookie a browser would ignore comes back `ok: false`. */
export function parseSetCookie(header: string, { requestPath, hosts, now }: ParseContext): ParsedSetCookie {
  if (CONTROL.test(header)) return { ok: false, reason: "control character" };
  const semicolon = header.indexOf(";");
  const nameValue = semicolon < 0 ? header : header.slice(0, semicolon);
  const equals = nameValue.indexOf("=");
  // Nameless cookies (`=v` or `v`) are valid in a browser; servers that rely on them are rare and a
  // `Cookie: v` header is ambiguous to most parsers, so the jar does not keep them.
  if (equals < 0) return { ok: false, reason: "no name" };
  const name = trimWsp(nameValue.slice(0, equals));
  const value = trimWsp(nameValue.slice(equals + 1));
  if (name === "") return { ok: false, reason: "no name" };
  if (byteLength(name) + byteLength(value) > MAX_NAME_VALUE_BYTES) return { ok: false, reason: "too large" };

  let expiresAt: number | undefined;
  let maxAge: number | undefined;
  let domain: string | undefined;
  let path: string | undefined;
  let secure = false;
  let httpOnly = false;
  let sameSite: SameSite = "unspecified";
  for (const attribute of semicolon < 0 ? [] : header.slice(semicolon + 1).split(";")) {
    const at = attribute.indexOf("=");
    const key = trimWsp(at < 0 ? attribute : attribute.slice(0, at)).toLowerCase();
    const raw = at < 0 ? "" : trimWsp(attribute.slice(at + 1));
    if (byteLength(raw) > MAX_ATTRIBUTE_VALUE_BYTES) continue;
    switch (key) {
      case "expires": {
        const date = parseCookieDate(raw);
        if (date !== undefined) expiresAt = date;
        break;
      }
      case "max-age":
        if (/^-?\d+$/.test(raw)) maxAge = Number(raw);
        break;
      case "domain":
        if (raw !== "") domain = (raw.startsWith(".") ? raw.slice(1) : raw).toLowerCase();
        break;
      case "path":
        path = raw.startsWith("/") ? raw : undefined;
        break;
      case "secure":
        secure = true;
        break;
      case "httponly":
        httpOnly = true;
        break;
      case "samesite": {
        const v = raw.toLowerCase();
        sameSite = v === "strict" ? "strict" : v === "lax" ? "lax" : v === "none" ? "no_restriction" : "unspecified";
        break;
      }
      // Partitioned, Priority and unknown attributes: nothing to do for a single first-party origin.
    }
  }

  if (domain !== undefined && !hosts.some((host) => host.toLowerCase() === domain)) {
    return { ok: false, reason: "foreign domain" };
  }
  const cookiePath = path ?? defaultPath(requestPath);
  const lower = name.toLowerCase();
  if (lower.startsWith("__secure-") && !secure) return { ok: false, reason: "__Secure- prefix without Secure" };
  // `__Host-` needs an explicit `Path=/`, as in Chromium: a default path of "/" does not count.
  if (lower.startsWith("__host-") && (!secure || domain !== undefined || path !== "/")) {
    return { ok: false, reason: "__Host- prefix rules" };
  }
  if (lower.startsWith("__http-") && (!secure || !httpOnly)) return { ok: false, reason: "__Http- prefix rules" };
  if (lower.startsWith("__host-http-") && !httpOnly) return { ok: false, reason: "__Host-Http- prefix rules" };
  if (sameSite === "no_restriction" && !secure) return { ok: false, reason: "SameSite=None without Secure" };

  // Max-Age wins over Expires (RFC 6265bis 5.7, step 3).
  let expiry: number | undefined;
  if (maxAge !== undefined) expiry = maxAge <= 0 ? -Infinity : now + Math.min(maxAge, MAX_AGE_S) * 1000;
  else if (expiresAt !== undefined) expiry = Math.min(expiresAt, now + MAX_AGE_S * 1000);
  if (expiry !== undefined && expiry <= now) return { ok: true, change: { kind: "delete", name, path: cookiePath } };

  const cookie: JarCookie = { name, value, path: cookiePath, secure, httpOnly, sameSite };
  if (expiry !== undefined) cookie.expirationDate = Math.floor(expiry / 1000);
  return { ok: true, change: { kind: "set", cookie } };
}

/** The default cookie path of a request path (RFC 6265bis 5.1.4). */
export function defaultPath(requestPath: string): string {
  if (!requestPath.startsWith("/")) return "/";
  const last = requestPath.lastIndexOf("/");
  return last <= 0 ? "/" : requestPath.slice(0, last);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** An `Expires` value as milliseconds since the epoch, per RFC 6265bis 5.1.1; undefined if invalid. */
export function parseCookieDate(value: string): number | undefined {
  let time: [number, number, number] | undefined;
  let day: number | undefined;
  let month: number | undefined;
  let year: number | undefined;
  // delimiter = %x09 / %x20-2F / %x3B-40 / %x5B-60 / %x7B-7E
  // oxlint-disable-next-line no-control-regex -- HTAB is one of the delimiters
  for (const token of value.split(/[\u0009 -/;-@[-`{-~]+/)) {
    if (token === "") continue;
    let m: RegExpExecArray | null;
    if (time === undefined && (m = /^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\D.*)?$/.exec(token))) {
      time = [Number(m[1]), Number(m[2]), Number(m[3])];
    } else if (day === undefined && (m = /^(\d{1,2})(?:\D.*)?$/.exec(token))) {
      day = Number(m[1]);
    } else if (month === undefined && MONTHS.includes(token.slice(0, 3).toLowerCase())) {
      month = MONTHS.indexOf(token.slice(0, 3).toLowerCase());
    } else if (year === undefined && (m = /^(\d{2,4})(?:\D.*)?$/.exec(token))) {
      year = Number(m[1]);
    }
  }
  if (time === undefined || day === undefined || month === undefined || year === undefined) return undefined;
  if (year >= 70 && year <= 99) year += 1900;
  else if (year >= 0 && year <= 69) year += 2000;
  const [hour, minute, second] = time;
  if (day < 1 || day > 31 || year < 1601 || hour > 23 || minute > 59 || second > 59) return undefined;
  const ms = Date.UTC(year, month, day, hour, minute, second);
  // Feb 30 and the like roll over in Date.UTC: the date does not exist.
  return new Date(ms).getUTCDate() === day ? ms : undefined;
}

/** A `Cookie` header: longer paths first, store order otherwise (RFC 6265bis 5.8.3, step 2). */
export function serializeCookieHeader(cookies: readonly { name: string; value: string; path?: string }[]): string {
  return cookies
    .map((cookie, index) => ({ cookie, index }))
    .toSorted((a, b) => (b.cookie.path ?? "/").length - (a.cookie.path ?? "/").length || a.index - b.index)
    .map(({ cookie }) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function trimWsp(s: string): string {
  return s.replace(/^[ \t]+|[ \t]+$/g, "");
}

/** The part of Electron's `Cookies` the jar uses, so tests can pass a fake. */
export interface CookieStore {
  get(filter: { url: string }): Promise<{ name: string; value: string; path?: string }[]>;
  set(details: {
    url: string;
    name: string;
    value: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite: SameSite;
    expirationDate?: number;
  }): Promise<void>;
  flushStore(): Promise<void>;
}

export interface CookieJar {
  /** The `Cookie` header for a request to `path`; undefined when no cookie applies or the store fails. */
  cookieHeader(path: string): Promise<string | undefined>;
  /**
   * Stores the `Set-Cookie`s of a response to a request for `requestPath`. Resolves once the store
   * has them and has flushed them to disk, so the next request sees them and a crash right after the
   * response neither loses them nor brings back what they replaced. Never rejects.
   */
  storeResponseCookies(headers: Headers, requestPath: string): Promise<void>;
}

export interface CookieJarOptions {
  store: CookieStore;
  /** Hosts a `Domain` attribute may name: the jar's own and the server's (the dev server's in development). */
  hosts: readonly string[];
  log: {
    debug(data: Record<string, unknown>, msg: string): void;
    warn(data: Record<string, unknown>, msg: string): void;
  };
  jarOrigin?: string;
  now?: () => number;
}

/**
 * The jar over a store. Cookies are host-only on `jarOrigin`; a deletion is a set with an expiry in
 * the past, which Chromium applies to exactly the cookie with that name, host and path.
 */
export function createCookieJar({
  store,
  hosts,
  log,
  jarOrigin = COOKIE_JAR_ORIGIN,
  now = Date.now,
}: CookieJarOptions): CookieJar {
  return {
    async cookieHeader(path) {
      try {
        const cookies = await store.get({ url: jarOrigin + path });
        return cookies.length === 0 ? undefined : serializeCookieHeader(cookies);
      } catch (err) {
        log.warn({ err }, "reading cookies failed");
        return undefined;
      }
    },
    async storeResponseCookies(headers, requestPath) {
      const values = headers.getSetCookie();
      if (values.length === 0) return;
      if (values.length > MAX_SET_COOKIES_PER_RESPONSE) {
        log.debug({ count: values.length }, "too many Set-Cookie headers; extra ones ignored");
      }
      // Flushed after any successful write, not only one with an expiry: a session cookie (or a
      // deletion) replacing a persistent one must remove the persistent record from the disk too, or
      // a crash brings the old value back. A flush with nothing persistent pending costs ~0.03 ms.
      let changed = false;
      for (const value of values.slice(0, MAX_SET_COOKIES_PER_RESPONSE)) {
        const parsed = parseSetCookie(value, { requestPath, hosts, now: now() });
        // Never the header: it carries the value.
        if (!parsed.ok) {
          log.debug({ reason: parsed.reason }, "Set-Cookie ignored");
          continue;
        }
        const { change } = parsed;
        // Always stored HttpOnly: Chromium refuses to let a non-HttpOnly write replace an HttpOnly
        // cookie (EXCLUDE_OVERWRITE_HTTP_ONLY), so `sid=1; HttpOnly` followed by `sid=2` would keep
        // sending `sid=1`, where a browser replaces it. The flag means nothing here otherwise: page
        // scripts never see these cookies, and the `__Http-` prefix rules were checked while parsing.
        const details =
          change.kind === "set"
            ? { ...change.cookie, httpOnly: true }
            : // Expired: Chromium removes the stored cookie with this name and path, and stores nothing.
              // Secure too, so it may replace a Secure cookie.
              {
                name: change.name,
                value: "",
                path: change.path,
                secure: true,
                httpOnly: true,
                sameSite: "unspecified" as const,
                expirationDate: 1,
              };
        try {
          await store.set({ url: jarOrigin + details.path, ...details });
          changed = true;
        } catch (err) {
          log.warn({ err, name: details.name }, "storing a cookie failed");
        }
      }
      if (!changed) return;
      try {
        await store.flushStore();
      } catch (err) {
        log.warn({ err }, "flushing cookies failed");
      }
    },
  };
}

/** How long quitting waits for the cookie store to reach the disk. */
export const QUIT_FLUSH_TIMEOUT_MS = 2_000;

/**
 * `flushStore()` for quitting, bounded: a store that never answers must not keep the app from
 * quitting. Resolves when the flush settles or after `timeoutMs`, whichever comes first; never rejects.
 */
export async function flushForQuit(
  store: Pick<CookieStore, "flushStore">,
  log: CookieJarOptions["log"],
  timeoutMs = QUIT_FLUSH_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const flushed = store.flushStore().then(
    () => "flushed" as const,
    (err: unknown) => {
      log.warn({ err }, "flushing cookies before quit failed");
      return "failed" as const;
    },
  );
  try {
    if ((await Promise.race([flushed, timeout])) === "timeout") {
      log.warn({ timeoutMs }, "flushing cookies before quit timed out; quitting anyway");
    }
  } finally {
    clearTimeout(timer);
  }
}
