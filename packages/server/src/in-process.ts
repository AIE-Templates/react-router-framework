import type { Hono, MiddlewareHandler } from "hono";

// Requests made in-process by a host's loaders and actions (see createInProcessFetch). Only server
// code can add to it, so unlike a header, it can't be forged by a client.
const inProcessRequests = new WeakSet<Request>();

declare module "hono" {
  interface ContextVariableMap {
    /** Whether the request was made in-process, e.g. by a React Router loader or action. */
    inProcess: boolean;
  }
}

/**
 * Sets `c.var.inProcess`. Register it first: middleware such as `bodyLimit()` replaces `c.req.raw`,
 * which would lose the marker.
 */
export function markInProcess(): MiddlewareHandler {
  return async (c, next) => {
    c.set("inProcess", inProcessRequests.has(c.req.raw));
    await next();
  };
}

/**
 * A `fetch` that calls `app` in-process, skipping the network: the same middleware runs as for
 * browser requests, except the API's CSRF check, which is meant for those. `app` is the server app,
 * or the host app that extends it.
 */
export function createInProcessFetch(app: Pick<Hono, "request">) {
  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = new Request(input, init);
    inProcessRequests.add(call);
    return Promise.resolve(app.request(call));
  };
}
