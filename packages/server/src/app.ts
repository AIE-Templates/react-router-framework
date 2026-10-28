import { Hono } from "hono";
import { cors } from "hono/cors";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import type { Logger } from "pino";

import { api } from "./api.ts";
import { wrapThrownValues } from "./errors.ts";
import { markInProcess } from "./in-process.ts";
import { logger, requestLogger } from "./logger.ts";

export interface ServerAppOptions {
  /**
   * Origins of browser apps served from elsewhere that call the API directly, e.g.
   * `["https://app.example.com"]`: they get CORS headers with credentials and pass the CSRF check.
   * Leave it unset when the API is only reached from its own origin, as when a host serves it with
   * its pages, or in-process.
   */
  allowedOrigins?: string[];
  /** The logger requests log with. Defaults to the package's. */
  logger?: Logger;
}

/**
 * The server app: request IDs and logging, error handling, the API under `/api` and a JSON 404 for
 * the rest of `/api`. It runs on its own (see `server.ts`) or as the base of a host app, which adds
 * its own routes after it, such as React Router pages.
 */
export function createServerApp({ allowedOrigins, logger: base = logger }: ServerAppOptions = {}): Hono {
  const app = new Hono();

  app.use(markInProcess());
  // Reuses a valid incoming X-Request-Id (e.g. from a gateway), otherwise generates one.
  app.use(requestId());
  // requestId() only sets the response header on responses built through `c`, so add it to the final
  // response too, e.g. pages rendered by a host.
  app.use(async (c, next) => {
    await next();
    c.header("X-Request-Id", c.var.requestId);
  });
  // Logs API calls from browsers, in-process calls from loaders and whatever a host adds.
  app.use(requestLogger(base));
  // So errors thrown as non-Error values still get a 500 and are logged.
  app.use(wrapThrownValues());
  // Reject paths with malformed percent-encoding, which React Router would otherwise warn about on
  // the console for every such request.
  app.use(async (c, next) => {
    try {
      decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text("Bad Request", 400);
    }
    return next();
  });

  // requestLogger() logs the error with the request, so only build the response here; Hono's default
  // handler would also print it unstructured.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    // Logging is silent in tests, so show the error there instead of a bare 500.
    if (process.env.NODE_ENV === "test") console.error(err);
    return c.text("Internal Server Error", 500);
  });

  if (allowedOrigins) {
    app.use("/api/*", cors({ origin: allowedOrigins, credentials: true, exposeHeaders: ["X-Request-Id"] }));
  }
  // React Router checks the origin of form submissions to actions, but /api/* is plain Hono: reject
  // cross-site form-like requests (form or text/plain bodies, which skip CORS preflight), which could
  // otherwise ride on the user's cookies. JSON requests from other origins are stopped by CORS.
  // In-process calls are server code, not browser requests, so they skip the check.
  const checkCsrf = csrf({
    origin: (origin, c) => origin === new URL(c.req.url).origin || (allowedOrigins?.includes(origin) ?? false),
  });
  app.use("/api/*", (c, next) => (c.var.inProcess ? next() : checkCsrf(c, next)));

  app.route("/", api);
  // Unknown API paths and methods get a JSON 404 instead of falling through to a host's pages.
  app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

  return app;
}

/**
 * Parses `ALLOWED_ORIGINS`, a comma-separated list of origins such as
 * `https://app.example.com,http://localhost:5173`. Throws on anything that is not a bare origin.
 */
export function parseAllowedOrigins(value: string | undefined): string[] | undefined {
  const origins = value
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (!origins?.length) return undefined;
  for (const origin of origins) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(origin);
    } catch {}
    if (parsed?.origin !== origin) {
      throw new Error(`Invalid origin "${origin}" in ALLOWED_ORIGINS: expected scheme://host[:port], no path`);
    }
  }
  return origins;
}
