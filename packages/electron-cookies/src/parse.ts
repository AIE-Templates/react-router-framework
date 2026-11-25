/// <reference lib="es2024.string" />
/** Longer attribute values are ignored (RFC 6265bis 5.6, step 7). */
export const MAX_ATTRIBUTE_VALUE_BYTES = 1024;
/** `Expires` and `Max-Age` are capped at 400 days (RFC 6265bis 5.6.1, 5.6.2). */
export const MAX_AGE_S = 400 * 24 * 60 * 60;
/** `sameSite` as Electron's cookie store spells it. */
export type SameSite = "unspecified" | "no_restriction" | "lax" | "strict";

export interface JarCookie {
  name: string;
  value: string;
  path: string;
  domain?: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite;
  /** Seconds since the epoch; absent for a session cookie. */
  expirationDate?: number;
}

export type ParsedSetCookie = { ok: true; cookie: JarCookie } | { ok: false; reason: string };

interface ParseContext {
  requestPath: string;
  now: number;
  serverDate?: number;
}

// oxlint-disable-next-line no-control-regex -- reject CTLs after stripping separator whitespace
const CONTROL = /[\u0000-\u001f\u007f]/;

function trimWsp(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, "");
}

function splitPair(segment: string): [string, string] {
  const equals = segment.indexOf("=");
  return equals < 0 ? [trimWsp(segment), ""] : [trimWsp(segment.slice(0, equals)), trimWsp(segment.slice(equals + 1))];
}

/** Parse the information that Electron's structured cookie API cannot recover from its fields. */
export function parseSetCookie(header: string, { requestPath, now, serverDate }: ParseContext): ParsedSetCookie {
  const [pair, ...attributes] = header.split(";");
  // Electron's structured store cannot retain the ill-formed bytes of a DOMString cookie pair.
  if (!pair.isWellFormed()) return { ok: false, reason: "invalid Unicode cookie pair" };
  const [name, value] = pair.includes("=") ? splitPair(pair) : ["", trimWsp(pair)];
  if (!name && !value) return { ok: false, reason: "empty cookie" };
  if (CONTROL.test(name) || CONTROL.test(value)) return { ok: false, reason: "control character" };
  let expiresAt: number | undefined;
  let maxAge: number | undefined;
  let domain: string | undefined;
  let path: string | undefined;
  let secure = false;
  let httpOnly = false;
  let sameSite: SameSite = "unspecified";
  let partitioned = false;
  for (const attribute of attributes) {
    const [attributeName, raw] = splitPair(attribute);
    if (CONTROL.test(attributeName) || CONTROL.test(raw)) return { ok: false, reason: "control character" };
    if (Buffer.byteLength(raw) > MAX_ATTRIBUTE_VALUE_BYTES) continue;
    switch (attributeName.toLowerCase()) {
      case "expires": {
        expiresAt = parseCookieDate(raw);
        break;
      }
      case "max-age":
        maxAge = /^-?\d+$/.test(raw) ? Number(raw) : undefined;
        break;
      case "domain":
        domain = raw || undefined;
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
      case "partitioned":
        partitioned = true;
        break;
    }
  }

  if (partitioned && !secure) return { ok: false, reason: "Partitioned without Secure" };
  if (name.toLowerCase().startsWith("__host-") && path !== "/")
    return { ok: false, reason: "__Host- needs explicit Path=/" };
  const cookiePath = path ?? defaultPath(requestPath);
  if (path !== undefined && (path.includes("|") || new URL("https://h" + path).pathname !== path)) {
    return { ok: false, reason: "noncanonical Path" };
  }
  const cookie: JarCookie = { name, value, path: cookiePath, secure, httpOnly, sameSite };
  if (domain !== undefined) {
    if (domain === "." || domain.startsWith("..")) return { ok: false, reason: "invalid Domain" };
    cookie.domain = domain.replace(/^\./, "").toLowerCase();
  }
  const lifetime = maxAge ?? (expiresAt === undefined ? undefined : (expiresAt - (serverDate ?? now)) / 1000);
  if (lifetime !== undefined) {
    cookie.expirationDate = lifetime <= 0 ? 1 : (now + Math.min(lifetime, MAX_AGE_S) * 1000) / 1000;
  }
  return { ok: true, cookie };
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
      if (m[1].length === 2) year += year >= 70 ? 1900 : 2000;
    }
  }
  if (time === undefined || day === undefined || month === undefined || year === undefined) return undefined;
  const [hour, minute, second] = time;
  if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second);
  // Feb 30 and the like roll over in Date.UTC: the date does not exist.
  if (date.getUTCDate() !== day) return undefined;
  return year < 1601 ? -Infinity : date.getTime();
}
