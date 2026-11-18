import { existsSync, type Stats, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { parseAccept } from "hono/utils/accept";
import { getMimeType } from "hono/utils/mime";

interface StaticFile {
  file: string;
  stats: Stats;
}

function pageOrFile(root: string, pathname: string): StaticFile | undefined {
  let file = join(root, pathname);
  let stats = statSync(file, { throwIfNoEntry: false });
  if (stats?.isDirectory()) {
    file = join(file, "index.html");
    stats = statSync(file, { throwIfNoEntry: false });
  }
  return stats?.isFile() ? { file, stats } : undefined;
}

const sidecars = { br: ".br", gzip: ".gz" };

// Use the selected file's modification time and length for both validators and byte ranges.
function representation(source: StaticFile, acceptEncoding: string) {
  let selected = { ...source, encoding: "identity" };
  if (!acceptEncoding) return selected;

  const accepted = new Map(parseAccept(acceptEncoding.toLowerCase()).map(({ type, q }) => [type, q]));
  const wildcard = accepted.get("*") ?? 0;
  // An implicit identity is the fallback after all accepted encodings, unless explicitly excluded.
  let best = accepted.get("identity") ?? (accepted.get("*") === 0 ? 0 : -1);
  for (const [encoding, suffix] of Object.entries(sidecars)) {
    const quality = accepted.get(encoding) ?? wildcard;
    if (quality <= 0 || quality <= best) continue;
    const file = source.file + suffix;
    const stats = statSync(file, { throwIfNoEntry: false });
    if (stats?.isFile()) {
      selected = { file, stats, encoding };
      best = quality;
    }
  }
  return best === 0 ? undefined : selected;
}

/** Serve build/client with the prerender and SPA fallbacks used by the nginx image. */
export function createStaticApp(clientDir: string) {
  const root = resolve(clientDir);
  const shell = existsSync(join(root, "__spa-fallback.html")) ? "__spa-fallback.html" : "index.html";
  const app = new Hono();
  app.get("*", async (c, next) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.notFound();
    }
    const segments = pathname.split("/").slice(1);
    // Only the public, top-level .well-known namespace is served from a dot directory.
    if (
      /[\\\0]/.test(pathname) ||
      (process.platform === "win32" && pathname.includes(":")) ||
      segments.some((part, i) => part.startsWith(".") && !(i === 0 && part === ".well-known"))
    ) {
      return c.notFound();
    }
    const assets = segments[0] === "assets";
    const source =
      pageOrFile(root, pathname) ?? (assets || segments[0] === ".well-known" ? undefined : pageOrFile(root, shell));
    if (!source) return c.notFound();

    c.header("Vary", "Accept-Encoding");
    const selected = representation(source, c.req.header("Accept-Encoding") ?? "");
    if (!selected) return c.body(null, 406);

    const modified = selected.stats.mtime.toUTCString();
    const lastModified = Date.parse(modified);
    const match = c.req.header("If-Match");
    const noneMatch = c.req.header("If-None-Match");
    // Files have a Last-Modified validator and no entity tag.
    if (match ? match !== "*" : lastModified > Date.parse(c.req.header("If-Unmodified-Since") ?? "")) {
      return c.body(null, 412);
    }
    c.header("Last-Modified", modified);
    c.header("Cache-Control", assets ? "public, max-age=31536000, immutable" : "no-cache");
    if (noneMatch ? noneMatch === "*" : lastModified <= Date.parse(c.req.header("If-Modified-Since") ?? "")) {
      return c.body(null, 304);
    }
    const range = c.req.header("Range");
    if (range) {
      const ifRange = c.req.header("If-Range");
      const bytes = /^bytes=(\d+-\d*|-\d+)$/i.exec(range)?.[1];
      const effective = bytes && (ifRange === undefined || ifRange === modified) ? `bytes=${bytes}` : undefined;
      if (range !== effective) {
        const headers = new Headers(c.req.raw.headers);
        if (effective) headers.set("Range", effective);
        else headers.delete("Range");
        c.req.raw = new Request(c.req.raw, { headers });
      }
    }
    c.header("Accept-Ranges", "bytes");
    const response = await serveStatic({ path: selected.file })(c, next);
    if (response?.status === 416) response.headers.set("Cache-Control", "no-cache");
    if (response?.ok && selected.encoding !== "identity") {
      response.headers.set("Content-Type", getMimeType(source.file) ?? "application/octet-stream");
      response.headers.set("Content-Encoding", selected.encoding);
    }
    return response;
  });
  return app;
}

if (import.meta.main) {
  serve({
    fetch: createStaticApp(join(import.meta.dirname, "build/client")).fetch,
    port: Number(process.env.PORT || 3000),
    hostname: process.env.HOST || "0.0.0.0",
  });
}
