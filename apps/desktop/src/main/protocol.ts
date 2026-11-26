import { randomUUID } from "node:crypto";

import { type CookieJar, CookieStoreTimeoutError, stripCookieMarkers } from "@repo/electron-cookies/main";
import { type PortFetch, PortClosedError } from "@repo/port-fetch";
import type { DesktopRequest } from "@repo/shared";
import type { WebRequestFilter } from "electron";

import { APP_ORIGIN, APP_SCHEME } from "./app-url.ts";
import type { BootProfile } from "./boot-profile.ts";
import { safeUrl } from "./log-url.ts";
import type { Logger } from "./log.ts";
import { failureStatus, shapeRequestHeaders, shapeResponseHeaders, toInternalUrl } from "./mapping.ts";

/** Bound the wait for upstream headers in both desktop modes. SSE and downloads may outlive it. */
export const REQUEST_HEADERS_TIMEOUT_MS = 60_000;

/** The part of Electron's `Session` the handler needs (structural, so tests can pass a fake). */
export interface ProtocolSession {
  protocol: {
    handle(scheme: string, handler: (request: Request & { initiatorOrigin?: string }) => Promise<Response>): void;
  };
  webRequest: {
    onBeforeSendHeaders(
      filter: WebRequestFilter,
      listener: (
        details: { id: number; webContentsId?: number; resourceType?: string; requestHeaders: Record<string, string> },
        next: (response: { requestHeaders: Record<string, string> }) => void,
      ) => void,
    ): void;
    onErrorOccurred(listener: (details: { id: number }) => void): void;
    onCompleted(listener: (details: { id: number }) => void): void;
  };
}

export interface AppProtocolOptions {
  /** Where requests go: the utility process over a port, or `react-router dev` in development. */
  upstream: PortFetch;
  /** The server's origin, as the mapped URLs name it. */
  internalOrigin: string;
  /** The window's current title bar mode, full-screen state and preferences, injected per request. */
  desktop: (contentsId?: number) => DesktopRequest;
  /** The server's cookies, which Chromium does not keep for `app://` (HOST-09). */
  cookies: Pick<CookieJar, "cookieHeader" | "storeResponseCookies">;
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
  // Electron gives webRequest a network ID but protocol.handle only a Request. Stamp the ID on
  // the app hop before dispatch. The session prefix distinguishes our stamp from page headers;
  // shapeRequestHeaders strips it upstream. Electron allows one listener per webRequest event.
  const header = "x-desktop-protocol-request";
  const prefix = randomUUID() + ":";
  const pending = new Map<string, { controller: AbortController; contentsId?: number; mainDocument: boolean }>();
  session.webRequest.onBeforeSendHeaders(
    { urls: [APP_ORIGIN + "/*"] },
    ({ id, webContentsId, resourceType, requestHeaders }, next) => {
      const key = prefix + id;
      if (!pending.has(key))
        pending.set(key, {
          controller: new AbortController(),
          contentsId: webContentsId,
          mainDocument: resourceType === "mainFrame",
        });
      for (const name of Object.keys(requestHeaders)) {
        if (name.toLowerCase() === header) delete requestHeaders[name];
      }
      requestHeaders[header] = key;
      next({ requestHeaders });
    },
  );
  // Terminal events also cover a request that never reaches the handler (or redirects off-origin).
  session.webRequest.onErrorOccurred(({ id }) => {
    const key = prefix + id;
    pending.get(key)?.controller.abort();
    pending.delete(key);
  });
  session.webRequest.onCompleted(({ id }) => pending.delete(prefix + id));

  session.protocol.handle(APP_SCHEME, async (request) => {
    const key = request.headers.get(header) ?? "";
    const entry = pending.get(key);
    const controller = entry?.controller;
    const signal = controller ? AbortSignal.any([request.signal, controller.signal]) : request.signal;
    try {
      if (!controller && key.startsWith(prefix)) return Response.error(); // Cancelled before dispatch.
      const internalUrl = toInternalUrl(request.url, internalOrigin);
      if (internalUrl === null) return new Response("Not Found", { status: 404 });
      const { pathname } = new URL(request.url);
      if (pathname.startsWith("/assets/")) profile.note("asset-requests", ++assetRequests);
      const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
      const headers = shapeRequestHeaders(request.headers, {
        method: request.method,
        initiatorOrigin: request.initiatorOrigin,
        desktop: desktop(entry?.contentsId),
        internalOrigin,
      });
      stripCookieMarkers(headers);
      const cookieRequest = { path: pathname, headers: request.headers, initiatorOrigin: request.initiatorOrigin };
      const cookie = await cookies.cookieHeader(cookieRequest, signal);
      signal.throwIfAborted();
      if (cookie !== undefined) headers.set("cookie", cookie);
      const forwarded = new Request(internalUrl, {
        method: request.method,
        signal,
        headers,
        body: hasBody ? request.body : null,
        ...(hasBody ? { duplex: "half" } : {}),
      });
      const isDocument = request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html");
      const response = await upstream(forwarded);
      if (isDocument) profile.mark("first-byte");
      await cookies.storeResponseCookies(response.headers, cookieRequest);
      if (signal.aborted) {
        // An upstream can finish despite cancellation, including while cookies were being stored.
        void response.body?.cancel().catch(() => {});
        return Response.error();
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: shapeResponseHeaders(response.headers, internalOrigin),
      });
    } catch (err) {
      if (signal.aborted) return Response.error();
      const { status, message } = failureStatus(err);
      // Never the full URL: query strings can carry tokens.
      log.error(
        { err, method: request.method, path: safeUrl(request.url, "path"), status },
        `${APP_SCHEME}:// request failed`,
      );
      // Let Electron report a failed main-document transport to the owning window's recovery.
      // An ordinary HTTP error from the host is still returned intact above.
      // A cookie store that did not answer is as transient: the request never left this process.
      if (entry?.mainDocument && (err instanceof PortClosedError || err instanceof CookieStoreTimeoutError)) {
        return Response.error();
      }
      return new Response(message, { status, headers: { "content-type": "text/plain", "retry-after": "1" } });
    } finally {
      // Once Electron has the response, abandoning it cancels the body directly.
      if (controller && pending.get(key) === entry) pending.delete(key);
    }
  });
}
