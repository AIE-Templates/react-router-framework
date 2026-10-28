import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono, MiddlewareHandler } from "hono";
import { compress } from "hono/compress";

import { createHostApp, type HostAppOptions } from "./app";
import { defaultPolicy, inlineScriptHashes, serializePolicy } from "./csp";

export interface WebAppOptions {
  /**
   * The client build: static files and, without server rendering, the SPA shell. Defaults to
   * `build/client` next to the server build this code runs from; other hosts pass where they keep it.
   */
  clientDir?: string;
  /** Whether the build renders on the server. Defaults to what the build says; tests set it. */
  ssr?: boolean;
  /** The Content-Security-Policy, for rendered documents and the SPA shell alike; see `createHostApp()`. */
  csp?: HostAppOptions["csp"];
  /**
   * Registers routes after the API and before static files, inside the same chain (request IDs,
   * logging, error handling). For a host's own routes.
   */
  extend?: (app: Hono) => void;
}

/**
 * The whole web app as one Hono app: the server (request IDs, logging, the API), static files from
 * the client build, the SPA shell for pages when the build has no server rendering, then React
 * Router. All in one middleware chain, so pages, files and the shell get request IDs, logging and
 * error handling like API calls.
 *
 * `server.ts` serves it on its own. Another Node.js server mounts it with `app.route("/", createWebApp())`
 * if it is Hono, or `getRequestListener(createWebApp().fetch)` from @hono/node-server otherwise.
 */
export function createWebApp({
  clientDir = defaultClientDir(),
  ssr,
  csp = defaultPolicy(),
  extend,
}: WebAppOptions = {}): Hono {
  return createHostApp({
    csp,
    extend: (app) => {
      extend?.(app);
      // Only built assets are compressed: compress() buffers streamed responses, which would hold back
      // React Router's streamed HTML and `.data` responses until everything has rendered. Leave
      // documents and API responses to a CDN or reverse proxy that compresses without buffering.
      app.use("/assets/*", compress(), staticFiles(clientDir, "public, max-age=31536000, immutable", csp));
      app.use(staticFiles(clientDir, "public, max-age=3600", csp));
      app.use(spaShell(clientDir, ssr, csp));
    },
  });
}

/** `build/client`, when this code runs from `build/server`. */
function defaultClientDir(): string {
  return resolve(import.meta.dirname, "../client");
}

/**
 * Serves files from `clientDir`. Only files it serves successfully get a Cache-Control header, so
 * responses from routes (e.g. a generated robots.txt) and errors such as 416 are left alone:
 * `cacheControl` for files, `no-cache` for prerendered documents (extensionless or .html paths) and
 * React Router `.data` files, so they revalidate and never point at assets from an old deploy.
 * Static HTML documents (the SPA shell at `/` and `/index.html`, prerendered pages) get the
 * Content-Security-Policy with their inline scripts allowed by hash, like the shell served by
 * `spaShell()`: they cannot carry a per-request nonce. The hashes come from the whole file on disk,
 * resolved the way `serveStatic` resolves it (the path itself, or `index.html` inside a directory),
 * so GET and HEAD carry the same policy, and HTML files never serve byte ranges (a partial body
 * would not match the hashes of the whole).
 */
function staticFiles(clientDir: string, cacheControl: string, csp?: HostAppOptions["csp"]): MiddlewareHandler {
  const serve = serveStatic({ root: clientDir });
  const policies = documentPolicies(csp);
  return async (c, next) => {
    // Static files answer GET and HEAD only; leave other methods untouched (and their bodies intact).
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    const { path } = c.req;
    const file = await resolveStaticFile(clientDir, path);
    const isHtml = file !== undefined && /\.html?$/i.test(file);
    const isDocument = isHtml || !/\.\w+$/.test(path) || /\.(html|data)$/.test(path);
    if (isHtml && c.req.raw.headers.has("range")) c.req.raw = withoutRange(c.req.raw);
    let found = true;
    const response = await serve(c, async () => {
      found = false;
      await next();
    });
    if (found && response?.ok) {
      response.headers.set("Cache-Control", isDocument ? "no-cache" : cacheControl);
      // Answer revalidation of an unchanged file with 304 instead of sending it again.
      if (response.status === 200 && isNotModified(c.req.raw.headers, response.headers.get("Last-Modified"))) {
        await response.body?.cancel();
        const headers = new Headers(response.headers);
        // The 200 may be gzip-compressed (/assets), so its length would differ.
        headers.delete("Content-Length");
        c.res = new Response(null, { status: 304, headers });
        return c.res;
      }
      if (csp && response.status === 200 && response.headers.get("content-type")?.startsWith("text/html")) {
        // From the file when it was resolved; otherwise from the body, so no document goes without.
        const policy = file
          ? await policies.forFile(file)
          : serializePolicy(csp, inlineScriptHashes(await response.clone().text()));
        response.headers.set("Content-Security-Policy", policy);
      }
    }
    return response;
  };
}

/** The Content-Security-Policy for a static HTML file, from its full content; cached until it changes on disk. */
function documentPolicies(csp: HostAppOptions["csp"]) {
  const cache = new Map<string, { mtimeMs: number; policy: string }>();
  return {
    async forFile(file: string): Promise<string> {
      if (!csp) return "";
      const { mtimeMs } = await stat(file);
      const cached = cache.get(file);
      if (cached?.mtimeMs === mtimeMs) return cached.policy;
      const policy = serializePolicy(csp, inlineScriptHashes(await readFile(file, "utf8")));
      cache.set(file, { mtimeMs, policy });
      return policy;
    },
  };
}

/**
 * The file `serveStatic({ root })` serves for `path`: the path itself when it is a file, or
 * `index.html` inside it when it is a directory; `undefined` when neither exists or the path
 * escapes `clientDir`.
 */
async function resolveStaticFile(clientDir: string, path: string): Promise<string | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  const root = resolve(clientDir);
  for (const candidate of [join(root, decoded), join(root, decoded, "index.html")]) {
    if (!resolve(candidate).startsWith(root)) continue;
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  return undefined;
}

/** `request` without its Range header: in place where headers are mutable, else a copy (GET/HEAD, no body). */
function withoutRange(request: Request): Request {
  try {
    request.headers.delete("range");
    return request;
  } catch {
    const headers = new Headers(request.headers);
    headers.delete("range");
    return new Request(request.url, { method: request.method, headers, signal: request.signal });
  }
}

function isNotModified(requestHeaders: Headers, lastModified: string | null): boolean {
  const ifModifiedSince = requestHeaders.get("If-Modified-Since");
  // If-None-Match takes precedence (RFC 9110 13.1.3); no ETags are sent, so it never matches.
  if (!ifModifiedSince || !lastModified || requestHeaders.has("If-None-Match")) return false;
  return Date.parse(lastModified) <= Date.parse(ifModifiedSince);
}

/**
 * Without server rendering (`SSR=false` at build time), serves the SPA shell React Router prebuilt
 * into the client build for every page, which React Router fills in the browser. Prerendered pages
 * were already served as static files, and API requests answered (unknown ones with the JSON 404),
 * both earlier in the chain. `.data` requests go on to React Router: prerendered routes may have
 * loaders, whose data is prerendered too, and React Router answers a request for a path that was not
 * with its 404, not the shell. (The route manifest is never fetched: a SPA build has it all up front.)
 * With server rendering, does nothing.
 */
function spaShell(clientDir: string, ssr: boolean | undefined, csp: HostAppOptions["csp"]): MiddlewareHandler {
  // The build is imported lazily, like in app.ts: tests stub it, and only need it when they don't
  // pass the mode themselves.
  const serverRendered = lazy(async () => ssr ?? (await import("virtual:react-router/server-build")).ssr);
  // A prebuilt document cannot carry a per-request nonce: its inline scripts are allowed by hash.
  const shell = lazy(async () => {
    const html = await readSpaShell(clientDir);
    const policy = csp ? serializePolicy(csp, inlineScriptHashes(html)) : undefined;
    return { html, policy };
  });
  return async (c, next) => {
    if (await serverRendered()) return next();
    const { method, path } = c.req;
    if ((method !== "GET" && method !== "HEAD") || path.endsWith(".data")) return next();
    const { html, policy } = await shell();
    // The shell revalidates on every load, so it never points at assets from an old deploy.
    return c.html(html, 200, {
      "Cache-Control": "no-cache",
      ...(policy ? { "Content-Security-Policy": policy } : {}),
    });
  };
}

/** Runs `load` on first use and keeps its result; a failure is retried on the next use, not kept. */
function lazy<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () =>
    (pending ??= load().catch((err: unknown) => {
      pending = undefined;
      throw err;
    }));
}

/** With prerendering, index.html is the prerendered home page and the shell is __spa-fallback.html. */
function readSpaShell(clientDir: string): Promise<string> {
  const fallback = join(clientDir, "__spa-fallback.html");
  return readFile(existsSync(fallback) ? fallback : join(clientDir, "index.html"), "utf8");
}
