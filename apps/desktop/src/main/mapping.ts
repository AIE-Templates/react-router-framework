import { PortBusyError, PortClosedError, PortFetchTimeoutError, RemoteFetchError } from "@repo/port-fetch";
import { DESKTOP_HEADERS, type DesktopRequest, isDesktopHeader } from "@repo/shared";

/** The origin pages run under. `standard` scheme, so `location.origin` is exactly this. */
export const APP_ORIGIN = "app://app";

/**
 * The origin the server sees instead. `app://` is not a special scheme for the URL parser, so its
 * origin serializes as the string "null": the API client would build `null/api/...` and React
 * Router's action check would never match. In development this is the `react-router dev` address.
 */
export const INTERNAL_ORIGIN = "http://app.desktop";

/** `app://app/path?query` → `<internalOrigin>/path?query`; `null` for any other host. */
export function toInternalUrl(appUrl: string, internalOrigin = INTERNAL_ORIGIN): string | null {
  const url = new URL(appUrl);
  if (url.protocol !== "app:" || url.host !== "app") return null;
  return internalOrigin + url.pathname + url.search;
}

/** Rewrites an absolute URL on the internal origin back to `app://app`; anything else is returned as is. */
export function toAppUrl(url: string, internalOrigin = INTERNAL_ORIGIN): string {
  return url.startsWith(internalOrigin + "/") || url === internalOrigin
    ? APP_ORIGIN + url.slice(internalOrigin.length)
    : url;
}

export interface RequestShape {
  method: string;
  /** What the main process knows about the window right now, injected as `x-desktop-*` headers. */
  desktop: DesktopRequest;
  internalOrigin?: string;
}

/**
 * The headers the server receives for a page's request:
 * - `Origin` and `Referer` are rewritten to the internal origin when present. Chromium does not
 *   send them for pages on a non-http(s) scheme, so on non-GET/HEAD requests an `Origin` of the
 *   internal origin and `Sec-Fetch-Site: same-origin` are synthesized: every request reaching the
 *   protocol handler comes from this app's pages (the window never navigates elsewhere), and Hono's
 *   CSRF check rejects form posts without one.
 * - Any `x-desktop-*` header a page sent is dropped, then the main process's own values are set, so
 *   page scripts cannot forge them.
 * - Any `Cookie` header is dropped: Chromium sends none for `app://`, and the cookies the server gets
 *   come from the main process's jar only (`cookie-jar.ts`), which the caller adds afterwards.
 */
export function shapeRequestHeaders(
  headers: Headers,
  { method, desktop, internalOrigin = INTERNAL_ORIGIN }: RequestShape,
): Headers {
  const out = new Headers();
  for (const [name, value] of headers) {
    if (isDesktopHeader(name) || name === "host" || name === "cookie") continue;
    out.append(name, name === "origin" || name === "referer" ? toInternal(value, internalOrigin) : value);
  }
  if (method !== "GET" && method !== "HEAD" && !out.has("origin")) {
    out.set("origin", internalOrigin);
    out.set("sec-fetch-site", "same-origin");
  }
  out.set(DESKTOP_HEADERS.titlebar, desktop.titlebar);
  out.set(DESKTOP_HEADERS.chromeMode, desktop.chromeMode);
  out.set(DESKTOP_HEADERS.fullscreen, desktop.fullscreen ? "1" : "0");
  out.set(DESKTOP_HEADERS.prefs, asciiJson(desktop.prefs));
  return out;
}

/**
 * JSON with every non-ASCII character as a `\uXXXX` escape (surrogate pairs become two escapes),
 * so the value is a valid header ByteString: `Headers` throws on code units above 255, and a Chinese
 * theme name in the preferences must not take every request down. `JSON.parse` undoes the escapes.
 */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Response headers for the page: an absolute `Location` on the internal origin goes back to
 * `app://app`, and `Set-Cookie` is removed: the main process's jar has stored it already, Chromium
 * ignores it on a protocol handler's response, and page scripts could never read it anyway.
 */
export function shapeResponseHeaders(headers: Headers, internalOrigin = INTERNAL_ORIGIN): Headers {
  const out = new Headers(headers);
  out.delete("set-cookie");
  const location = out.get("location");
  if (location) out.set("location", toAppUrl(location, internalOrigin));
  return out;
}

function toInternal(value: string, internalOrigin: string): string {
  return value.startsWith(APP_ORIGIN + "/") || value === APP_ORIGIN
    ? internalOrigin + value.slice(APP_ORIGIN.length)
    : value;
}

/**
 * The status and text an `app://` request gets when the port fetch fails. Transient failures that
 * never reached the app (the utility restarting, either side's request budget) are 503 so a retry
 * makes sense; a missing response is 504; anything else, the app's own failure included, is 500.
 */
export function failureStatus(err: unknown): { status: 500 | 503 | 504; message: string } {
  if (err instanceof PortClosedError) return { status: 503, message: "Server Restarting" };
  if (err instanceof PortBusyError || (err instanceof RemoteFetchError && err.code === "busy")) {
    return { status: 503, message: "Server Busy" };
  }
  if (err instanceof PortFetchTimeoutError) return { status: 504, message: "Internal Server Error" };
  return { status: 500, message: "Internal Server Error" };
}
