import { createApiClient, createInProcessFetch, createServerApp, logger } from "@repo/server";
import {
  type DesktopRequest,
  isDesktopHeader,
  parseDesktopHeaders,
  type Shell,
  shellFromEnv,
  WEB_SHELL,
} from "@repo/shared";
import type { Hono, MiddlewareHandler } from "hono";
import type { Logger } from "pino";
import { createRequestHandler, RouterContextProvider } from "react-router";

import { apiContext } from "~/lib/api";
import { cspNonceContext } from "~/lib/csp";
import { loggerContext } from "~/lib/logger";
import { preferencesContext, requestPreferences } from "~/lib/preferences";
import { desktopContext, shellContext } from "~/lib/shell";

import { type ContentSecurityPolicy, cspMiddleware, defaultPolicy } from "./csp";

declare module "hono" {
  interface ContextVariableMap {
    /** Where the app runs, from the host's entry point. Set for every request that reaches React Router. */
    shell: Shell;
    /** The desktop shell's per-request facts from its `x-desktop-*` headers; unset outside it. */
    desktop?: DesktopRequest;
  }
}

export { logStreamErrors } from "@repo/server";

const handleRequest = createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE);

export interface HostAppOptions {
  /**
   * Where the app runs, fixed for the life of the process: `{ kind: "web" }` (the default) or the
   * desktop shell, whose entry passes it. Only the desktop shell trusts `x-desktop-*` request headers.
   */
  shell?: Shell;
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
 * React Router catch-all; then the shell middleware sets `c.var.shell` (and `c.var.desktop`), which
 * loaders read through `shellContext` (and `desktopContext`).
 *
 * Everything the server did not handle falls through to React Router: it renders pages when `ssr`
 * is on, and the SPA shell (root route with HydrateFallback) otherwise, which is also how the shell
 * is prebuilt.
 */
export function createHostApp({ shell = WEB_SHELL, extend, csp = defaultPolicy() }: HostAppOptions = {}): Hono {
  const app = createServerApp();
  // Loaders and actions call this app's API in-process, under the request's ID and logger.
  const fetch = createInProcessFetch(app);
  extend?.(app);
  app.use(shellMiddleware(shell));
  if (csp) app.use(cspMiddleware(csp));
  app.all("*", (c) =>
    handleRequest(
      c.req.raw,
      createLoadContext(c.req.raw, {
        requestId: c.var.requestId,
        logger: c.var.logger,
        fetch,
        shell: c.var.shell,
        desktop: c.var.desktop,
        cspNonce: csp ? c.var.cspNonce : undefined,
      }),
    ),
  );
  return app;
}

/**
 * Sets `c.var.shell`, and handles the desktop shell's `x-desktop-*` headers: the desktop shell parses
 * them into `c.var.desktop`; any other shell removes them, so a browser cannot pose as the desktop app.
 */
function shellMiddleware(shell: Shell): MiddlewareHandler {
  return async (c, next) => {
    c.set("shell", shell);
    if (shell.kind === "desktop") c.set("desktop", parseDesktopHeaders(c.req.raw.headers));
    else c.req.raw = withoutDesktopHeaders(c.req.raw);
    await next();
  };
}

/**
 * Removes every `x-desktop-*` header from `request`, in place: the request React Router receives is
 * this one, and requests from @hono/node-server cannot be copied with `new Request(request, init)`
 * (they are not native Requests while it leaves the globals alone, as `startServer()` does). Where
 * headers are immutable (incoming requests on some runtimes), returns a copy built from the request's
 * method, body and abort signal instead.
 */
function withoutDesktopHeaders(request: Request): Request {
  const names = [...request.headers.keys()].filter(isDesktopHeader);
  if (names.length === 0) return request;
  try {
    for (const name of names) request.headers.delete(name);
    return request;
  } catch {
    const headers = new Headers(request.headers);
    for (const name of names) headers.delete(name);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    return new Request(request.url, {
      method: request.method,
      headers,
      body: hasBody ? request.body : null,
      signal: request.signal,
      ...(hasBody ? { duplex: "half" } : {}),
    });
  }
}

let hostApp: Hono | undefined;

/**
 * The host app without static files, built on first use: what `react-router dev` serves, prerendering
 * renders with and `createLoadContext()` calls by default. Production imports this module too (it is
 * part of the server build) but only calls `createWebApp()`, so nothing idle is built there. In
 * development, Vite re-evaluates the module when server code changes, which resets the cache.
 */
export function getHostApp(): Hono {
  return (hostApp ??= createHostApp({ shell: developmentShell() }));
}

/**
 * The shell for `getHostApp()`. No entry passes options there, so in development the shell comes
 * from the process that started this one: the desktop dev script sets WEB_SHELL=desktop and the
 * platform; plain `pnpm dev` leaves it web. Anywhere else (prerendering the SPA shell during
 * `react-router build`, which also loads .env) it is always web, so a WEB_SHELL left in .env for
 * development never ends up in a build.
 */
export function developmentShell(
  env: Record<string, string | undefined> = process.env,
  development: boolean = import.meta.env.DEV,
): Shell {
  return development ? shellFromEnv(env) : WEB_SHELL;
}

/** What a request's loaders and actions share with the API calls they make. */
interface RequestScope {
  /** Sent as X-Request-Id, so in-process calls log under the caller's request ID. */
  requestId?: string;
  logger?: Logger;
  /** Calls the API in-process. Defaults to calling `getHostApp()`. */
  fetch?: ReturnType<typeof createInProcessFetch>;
  /** Where the app runs. Defaults to the web shell. */
  shell?: Shell;
  /** The desktop shell's per-request facts; only set in the desktop shell. */
  desktop?: DesktopRequest;
  /** The document's Content-Security-Policy nonce, for the inline scripts React Router emits. */
  cspNonce?: string;
}

/**
 * The React Router context loaders and actions get for `request`: a typed API client that calls the
 * app in-process on behalf of the user who made `request`, the request's logger, the shell and, in
 * the desktop shell, its per-request facts, and the preferences `getPreference()` reads.
 */
export function createLoadContext(
  request: Request,
  {
    requestId,
    logger: log = logger,
    fetch = createInProcessFetch(getHostApp()),
    shell = WEB_SHELL,
    desktop,
    cspNonce,
  }: RequestScope = {},
): RouterContextProvider {
  const context = new RouterContextProvider();
  context.set(apiContext, createApiClient(request, { fetch, requestId }));
  context.set(loggerContext, log);
  context.set(shellContext, shell);
  context.set(desktopContext, desktop);
  context.set(preferencesContext, requestPreferences(shell, request, desktop));
  context.set(cspNonceContext, cspNonce);
  return context;
}
