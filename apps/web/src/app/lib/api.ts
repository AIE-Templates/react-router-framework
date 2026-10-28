import type { ApiClient, ApiType } from "@repo/server/types";
import { hc } from "hono/client";
import { createContext } from "react-router";

export type { ApiClient };

// Where browser code finds the API: this origin, which serves it next to the pages. For a static
// deployment of the client build with the server running elsewhere, set VITE_API_ORIGIN to the
// server's origin and list this app's origin in its ALLOWED_ORIGINS.
const apiOrigin: string = import.meta.env.VITE_API_ORIGIN || "/";

/** Typed API client for browser code: components and `clientLoader`/`clientAction`. */
export const api: ApiClient = hc<ApiType>(apiOrigin, {
  // Cross-origin calls only send cookies when asked to.
  init: apiOrigin === "/" ? undefined : { credentials: "include" },
  fetch: (input: RequestInfo | URL, init?: RequestInit) => {
    // On the server a relative URL can't be fetched, and the call would lose the user's identity.
    if (typeof window === "undefined") {
      throw new Error("`api` is for browser code. In loaders and actions, use `context.get(apiContext)`.");
    }
    return fetch(input, init);
  },
});

/**
 * Typed API client for `loader`/`action`, read with `context.get(apiContext)`. src/host/app.ts sets
 * it per request: it calls the server in-process and forwards the caller's cookie and authorization
 * headers. In tests, use `createTestContext()` from src/host/testing.ts.
 */
export const apiContext = createContext<ApiClient>();
