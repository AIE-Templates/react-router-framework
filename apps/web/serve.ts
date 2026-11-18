import { existsSync } from "node:fs";
import { join } from "node:path";

import express from "express";
import expressStaticGzip from "express-static-gzip";

/** Serve the client build using the same asset and page fallbacks as nginx. */
export function createStaticApp(clientDir: string) {
  const app = express();
  app.disable("x-powered-by");
  const shell = existsSync(join(clientDir, "__spa-fallback.html")) ? "/__spa-fallback.html" : "/index.html";
  const files = expressStaticGzip(clientDir, {
    enableBrotli: true,
    serveStatic: {
      redirect: false,
      etag: false,
      setHeaders(res, _path, stat) {
        const req = res.req;
        const validator = req.headers["if-range"];
        if (validator && validator !== stat.mtime.toUTCString()) delete req.headers.range;
        res.setHeader(
          "Cache-Control",
          req.url?.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        );
      },
    },
  });
  app.get(/.*/, (req, res, next) => {
    files(req, res, (error?: unknown) => {
      if (error || req.path.startsWith("/assets/")) return next(error);
      // A prerendered route can be requested without a trailing slash.
      req.url = req.path.replace(/\/$/, "") + "/index.html";
      files(req, res, (indexError?: unknown) => {
        if (indexError) return next(indexError);
        req.url = shell;
        files(req, res, next);
      });
    });
  });
  return app;
}

if (import.meta.main) {
  createStaticApp(join(import.meta.dirname, "build/client")).listen(
    Number(process.env.PORT || 3000),
    process.env.HOST || "0.0.0.0",
  );
}
