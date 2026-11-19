import { setTimeout as delay } from "node:timers/promises";

import { PortFetchTimeoutError, type PortFetch } from "@repo/port-fetch";

import { REQUEST_HEADERS_TIMEOUT_MS } from "./protocol.ts";

const RETRY_MS = 250;
const RETRY_FOR_MS = 5_000;

/**
 * Development: requests go to `react-router dev` instead of the utility process, so server code
 * hot-reloads. Node's own `fetch` with `redirect: "manual"` returns 30x responses as they are;
 * `net.fetch` would follow them and hand the target page back under the original URL.
 *
 * The dev server restarts itself (once at startup, with `--conditions=development`, and whenever
 * its config changes). Retry GET and HEAD while it comes back. A reset can happen after a write
 * was processed, even when that request had no body.
 */
export function createDevProxyFetch(): PortFetch {
  return async (request) => {
    const timeout = new AbortController();
    const signal = AbortSignal.any([request.signal, timeout.signal]);
    const timer = setTimeout(() => {
      timeout.abort(new PortFetchTimeoutError(REQUEST_HEADERS_TIMEOUT_MS, "headers"));
    }, REQUEST_HEADERS_TIMEOUT_MS);
    try {
      return await fetchWithRetry(request, signal);
    } catch (err) {
      // fetch and the retry delay can wrap an abort; preserve the reason (including a headers timeout).
      signal.throwIfAborted();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

async function fetchWithRetry(request: Request, signal: AbortSignal): Promise<Response> {
  const canRetry = request.method === "GET" || request.method === "HEAD";
  const hasBody = !canRetry && request.body !== null;
  const deadline = Date.now() + RETRY_FOR_MS;
  for (;;) {
    try {
      return await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: hasBody ? request.body : null,
        redirect: "manual",
        signal,
        ...(hasBody ? { duplex: "half" } : {}),
      });
    } catch (err) {
      if (!canRetry || signal.aborted || Date.now() >= deadline || !isConnectionFailure(err)) throw err;
      await delay(RETRY_MS, undefined, { signal });
    }
  }
}

/** `fetch failed` with a connection refused/reset cause: the dev server is not listening right now. */
function isConnectionFailure(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const code = err.cause instanceof Error && "code" in err.cause ? err.cause.code : undefined;
  return code === undefined || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "UND_ERR_SOCKET";
}
