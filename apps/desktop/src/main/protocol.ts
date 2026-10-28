import type { PortFetch } from "@repo/port-fetch";
import type { DesktopRequest } from "@repo/shared";

import type { BootProfile } from "./boot-profile.ts";
import type { CookieJar } from "./cookie-jar.ts";
import type { Logger } from "./log.ts";
import { failureStatus, shapeRequestHeaders, shapeResponseHeaders, toInternalUrl } from "./mapping.ts";

export const APP_SCHEME = "app";

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "(invalid URL)";
  }
}

/** The part of Electron's `Session` the handler needs (structural, so tests can pass a fake). */
export interface ProtocolSession {
  protocol: { handle(scheme: string, handler: (request: Request) => Promise<Response>): void };
}

export interface AppProtocolOptions {
  /** Where requests go: the utility process over a port, or `react-router dev` in development. */
  upstream: PortFetch;
  /** The server's origin, as the mapped URLs name it. */
  internalOrigin: string;
  /** The window's current title bar mode, full-screen state and preferences, injected per request. */
  desktop: () => DesktopRequest;
  /** The server's cookies, which Chromium does not keep for `app://` (HOST-09). */
  cookies: CookieJar;
  log: Logger;
  profile: BootProfile;
}

/**
 * Serves `app://app/*` for `session`: maps the URL and headers to the internal origin, adds the
 * jar's `Cookie`, forwards the request upstream, stores the response's `Set-Cookie` in the jar (before
 * handing the response back, so the next request sees them), maps the response back. Everything is
 * caught: a throwing handler would be an uncaught exception in the main process, which Electron
 * answers with a blocking dialog.
 */
export function registerAppProtocol(
  session: ProtocolSession,
  { upstream, internalOrigin, desktop, cookies, log, profile }: AppProtocolOptions,
): void {
  // How many hashed assets the first page pulls through the port (7 today). Serving them from the
  // main process instead was measured in step 6 and made no difference to first paint.
  let assetRequests = 0;
  session.protocol.handle(APP_SCHEME, async (request) => {
    try {
      const internalUrl = toInternalUrl(request.url, internalOrigin);
      if (internalUrl === null) return new Response("Not Found", { status: 404 });
      const { pathname } = new URL(request.url);
      if (pathname.startsWith("/assets/")) profile.note("asset-requests", ++assetRequests);
      const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
      const headers = shapeRequestHeaders(request.headers, {
        method: request.method,
        desktop: desktop(),
        internalOrigin,
      });
      const cookie = await cookies.cookieHeader(pathname);
      if (cookie !== undefined) headers.set("cookie", cookie);
      const forwarded = new Request(internalUrl, {
        method: request.method,
        headers,
        body: hasBody ? request.body : null,
        ...(hasBody ? { duplex: "half" } : {}),
      });
      const isDocument = request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html");
      const response = await upstream(forwarded);
      if (isDocument) profile.mark("first-byte");
      await cookies.storeResponseCookies(response.headers, pathname);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: shapeResponseHeaders(response.headers, internalOrigin),
      });
    } catch (err) {
      const { status, message } = failureStatus(err);
      // Never the full URL: query strings can carry tokens.
      log.error({ err, method: request.method, path: safePathname(request.url), status }, "app:// request failed");
      return new Response(message, { status, headers: { "content-type": "text/plain", "retry-after": "1" } });
    }
  });
}
