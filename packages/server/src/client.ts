import { hc } from "hono/client";

import type { ApiType } from "./api.ts";

/** A typed client for the API, from Hono's RPC client. */
export type ApiClient = ReturnType<typeof hc<ApiType>>;

const FORWARDED_HEADERS = ["authorization", "cookie"];

export interface ApiClientOptions {
  /** Where the API runs. Defaults to the caller's origin, which is right for in-process calls. */
  origin?: string;
  /**
   * How to reach it: `createInProcessFetch(app)` when the host runs the server itself, or the global
   * `fetch` (the default) for a server running on its own.
   */
  fetch?: typeof fetch;
  /** Sent as X-Request-Id, so the calls log under the caller's request ID. */
  requestId?: string;
}

/**
 * A typed client that calls the API on behalf of `caller`, a user's request to a server-side host
 * such as a React Router loader or action: it forwards the caller's cookie and authorization headers
 * and nothing else, and its calls are aborted with the caller's request, e.g. when the user disconnects.
 */
export function createApiClient(
  caller: Request,
  { origin = new URL(caller.url).origin, fetch, requestId }: ApiClientOptions = {},
): ApiClient {
  return hc<ApiType>(origin, {
    fetch: (input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal ? AbortSignal.any([caller.signal, init.signal]) : caller.signal;
      return fetch ? fetch(input, { ...init, signal }) : globalThis.fetch(input, { ...init, signal });
    },
    headers: () => {
      const headers: Record<string, string> = {};
      for (const name of FORWARDED_HEADERS) {
        const value = caller.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      if (requestId) headers["x-request-id"] = requestId;
      return headers;
    },
  });
}
