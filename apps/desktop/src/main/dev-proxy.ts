import type { PortFetch } from "@repo/port-fetch";

const RETRY_MS = 250;
const RETRY_FOR_MS = 5_000;

/**
 * Development: requests go to `react-router dev` instead of the utility process, so server code
 * hot-reloads. Node's own `fetch` with `redirect: "manual"` returns 30x responses as they are;
 * `net.fetch` would follow them and hand the target page back under the original URL.
 *
 * The dev server restarts itself (once at startup, with `--conditions=development`, and whenever
 * its config changes); a request that cannot connect while it is away is retried for a few seconds
 * instead of becoming a 500 in the window. Requests with a body are not retried: it was consumed.
 */
export function createDevProxyFetch(): PortFetch {
  return async (request) => {
    const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
    const deadline = Date.now() + RETRY_FOR_MS;
    for (;;) {
      try {
        return await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: hasBody ? request.body : null,
          redirect: "manual",
          signal: request.signal,
          ...(hasBody ? { duplex: "half" } : {}),
        });
      } catch (err) {
        if (hasBody || request.signal.aborted || Date.now() >= deadline || !isConnectionFailure(err)) throw err;
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    }
  };
}

/** `fetch failed` with a connection refused/reset cause: the dev server is not listening right now. */
function isConnectionFailure(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const code = err.cause instanceof Error && "code" in err.cause ? err.cause.code : undefined;
  return code === undefined || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "UND_ERR_SOCKET";
}
