import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { serveStatic } from "@hono/node-server/serve-static";
import type { Shell } from "@repo/shared";
import type { Hono, MiddlewareHandler } from "hono";
import { compress } from "hono/compress";

import { createHostApp, type HostAppOptions } from "./app";
import { defaultPolicy, inlineScriptHashes, serializePolicy } from "./csp";

export interface WebAppOptions {
  /**
   * The client build: static files and, without server rendering, the SPA shell. Defaults to
   * `build/client` next to the server build this code runs from; Electron passes where it unpacked it.
   */
  clientDir?: string;
  /** Whether the build renders on the server. Defaults to what the build says; tests set it. */
  ssr?: boolean;
  /**
   * Where the app runs: `{ kind: "web" }` (the default) or the desktop shell, whose entry passes its
   * platform once at startup. Only the desktop shell trusts `x-desktop-*` request headers; see
   * `createHostApp()`. `server.ts` and other web hosts leave it out.
   */
  shell?: Shell;
  /** The Content-Security-Policy, for rendered documents and the SPA shell alike; see `createHostApp()`. */
  csp?: HostAppOptions["csp"];
  /**
   * Registers routes after the API and before static files, inside the same chain (request IDs,
   * logging, error handling). For a host's own routes; the desktop smoke mounts its smoke-only
   * endpoints here.
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
 * The Electron shell (apps/desktop) runs it in a utility process behind an `app://` scheme, with the
 * URL and header mapping that scheme needs; see its README before wiring a custom scheme by hand.
 */
export function createWebApp({
  clientDir = defaultClientDir(),
  ssr,
  shell,
  csp = defaultPolicy(),
  extend,
}: WebAppOptions = {}): Hono {
  return createHostApp({
    shell,
    ssr,
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
    const range = c.req.raw.headers.get("range");
    if (file && range !== null) {
      const validator = c.req.raw.headers.get("if-range");
      const bytes = /^bytes=(\d+-\d*|-\d+)$/i.exec(range)?.[1];
      // This host only emits Last-Modified. An entity tag cannot match that validator.
      const effective =
        !isHtml && bytes && (validator === null || validator === (await stat(file)).mtime.toUTCString())
          ? `bytes=${bytes}`
          : undefined;
      if (range !== effective) {
        c.req.raw = withRange(c.req.raw, effective);
      }
    }
    let found = true;
    const response = await serve(c, async () => {
      found = false;
      await next();
    });
    if (found && response && (response.ok || response.status === 416)) {
      // Range is evaluated only after cache preconditions, including for unsatisfiable ranges.
      const status = preconditionStatus(c.req.raw.headers, response.headers.get("Last-Modified"));
      if (status) {
        await response.body?.cancel();
        const headers = new Headers(response.headers);
        headers.set("Cache-Control", status === 412 || isDocument ? "no-cache" : cacheControl);
        headers.delete("Content-Length");
        headers.delete("Content-Range");
        c.res = new Response(null, { status, headers });
        return c.res;
      }
      if (!response.ok) return response;
      response.headers.set("Cache-Control", isDocument ? "no-cache" : cacheControl);
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
    const fromRoot = relative(root, candidate);
    if (fromRoot === ".." || fromRoot.startsWith(".." + sep) || isAbsolute(fromRoot)) continue;
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  return undefined;
}

/** `request` with its Range header normalized or removed: in place where headers are mutable, else a copy (GET/HEAD, no body). */
function withRange(request: Request, range?: string): Request {
  try {
    if (range) request.headers.set("range", range);
    else request.headers.delete("range");
    return request;
  } catch {
    const headers = new Headers(request.headers);
    if (range) headers.set("range", range);
    else headers.delete("range");
    return new Request(request.url, { method: request.method, headers, signal: request.signal });
  }
}

function preconditionStatus(headers: Headers, lastModified: string | null): 304 | 412 | undefined {
  // The selected file exists and has no ETag. Only the wildcard can match.
  const modified = Date.parse(lastModified ?? "");
  const match = headers.get("If-Match");
  if (match !== null ? match.trim() !== "*" : modified > Date.parse(headers.get("If-Unmodified-Since") ?? "")) {
    return 412;
  }
  const noneMatch = headers.get("If-None-Match");
  if (noneMatch !== null ? noneMatch.trim() === "*" : modified <= Date.parse(headers.get("If-Modified-Since") ?? "")) {
    return 304;
  }
  return undefined;
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
    if (method !== "GET" && method !== "HEAD") return next();
    if (path.startsWith("/assets/") || path === "/.well-known" || path.startsWith("/.well-known/")) return c.notFound();
    if (path.endsWith(".data")) return next();
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
