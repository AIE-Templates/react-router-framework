import { createApiClient, createInProcessFetch, createServerApp, logger } from "@repo/server";
import type { Hono } from "hono";
import type { Logger } from "pino";
import { createRequestHandler, RouterContextProvider } from "react-router";

import { visualCookie } from "~/config/visual-cookie";
import { apiContext } from "~/lib/api";
import { cspNonceContext } from "~/lib/csp";
import { loggerContext } from "~/lib/logger";

import { type ContentSecurityPolicy, cspMiddleware, defaultPolicy } from "./csp";

export { logStreamErrors } from "@repo/server";

const handleRequest = createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE);

export interface HostAppOptions {
  /**
   * Registers middleware and routes after the API and its JSON 404 and before React Router;
   * `createWebApp()` adds static files and the SPA shell there.
   */
  extend?: (app: Hono) => void;
  /**
   * The Content-Security-Policy for documents React Router renders (inline scripts get the request's
   * nonce). Defaults to `defaultPolicy()`; `false` sends none.
   */
  csp?: ContentSecurityPolicy | false;
}

/**
 * Builds a host app: @repo/server (request IDs, logging, the API under /api) with React Router for
 * everything else, in one process, so the server's middleware runs for page requests too. `extend`
 * registers middleware and routes between the two, after the API and its JSON 404 and before the
 * React Router catch-all.
 *
 * Everything the server did not handle falls through to React Router: it renders pages when `ssr`
 * is on, and the SPA shell (root route with HydrateFallback) otherwise, which is also how the shell
 * is prebuilt.
 */
export function createHostApp({ extend, csp = defaultPolicy() }: HostAppOptions = {}): Hono {
  const app = createServerApp();
  // Loaders and actions call this app's API in-process, under the request's ID and logger.
  const fetch = createInProcessFetch(app);
  if (visualCookie.enabled)
    app.use(async (c, next) => {
      await next();
      if (c.res.headers.get("content-type")?.includes("text/html") || c.req.path.endsWith(".data"))
        c.header("Cache-Control", "private, no-store");
    });
  extend?.(app);
  if (csp) app.use(cspMiddleware(csp));
  app.all("*", (c) =>
    handleRequest(
      c.req.raw,
      createLoadContext(c.req.raw, {
        requestId: c.var.requestId,
        logger: c.var.logger,
        fetch,
        cspNonce: csp ? c.var.cspNonce : undefined,
      }),
    ),
  );
  return app;
}

let hostApp: Hono | undefined;

/**
 * The host app without static files, built on first use: what `react-router dev` serves, prerendering
 * renders with and `createLoadContext()` calls by default. Production imports this module too (it is
 * part of the server build) but only calls `createWebApp()`, so nothing idle is built there. In
 * development, Vite re-evaluates the module when server code changes, which resets the cache.
 */
export function getHostApp(): Hono {
  return (hostApp ??= createHostApp());
}

/** What a request's loaders and actions share with the API calls they make. */
interface RequestScope {
  /** Sent as X-Request-Id, so in-process calls log under the caller's request ID. */
  requestId?: string;
  logger?: Logger;
  /** Calls the API in-process. Defaults to calling `getHostApp()`. */
  fetch?: ReturnType<typeof createInProcessFetch>;
  /** The document's Content-Security-Policy nonce, for the inline scripts React Router emits. */
  cspNonce?: string;
}

/**
 * The React Router context loaders and actions get for `request`: a typed API client that calls the
 * app in-process on behalf of the user who made `request`, the request's logger and the document's
 * Content-Security-Policy nonce.
 */
export function createLoadContext(
  request: Request,
  { requestId, logger: log = logger, fetch = createInProcessFetch(getHostApp()), cspNonce }: RequestScope = {},
): RouterContextProvider {
  const context = new RouterContextProvider();
  context.set(apiContext, createApiClient(request, { fetch, requestId }));
  context.set(loggerContext, log);
  context.set(cspNonceContext, cspNonce);
  return context;
}
