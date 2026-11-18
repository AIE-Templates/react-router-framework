// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { serve } from "@hono/node-server";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createStaticApp } from "../serve";

const root = mkdtempSync(join(tmpdir(), "static-client-"));
mkdirSync(join(root, ".well-known"));
writeFileSync(join(root, ".well-known/assetlinks.json"), "[]");
mkdirSync(join(root, "docs"));
writeFileSync(join(root, "docs/index.html"), "docs");
writeFileSync(join(root, "index.html"), "home");
writeFileSync(join(root, "__spa-fallback.html"), "shell");
writeFileSync(join(root, "sample.txt"), "abcdefgh");
const modified = new Date("2025-01-01T00:00:00Z");
utimesSync(join(root, "sample.txt"), modified, modified);
writeFileSync(join(root, "sample.txt.gz"), gzipSync("abcdefgh"));
const server = serve({ fetch: createStaticApp(root).fetch, port: 0, hostname: "127.0.0.1" });
let origin: string;
beforeAll(async () => {
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

it("serves prerenders and dotted page routes, and rejects missing assets", async () => {
  for (const [path, body] of [
    ["/", "home"],
    ["/docs", "docs"],
    ["/docs/", "docs"],
    ["/users/jane.doe", "shell"],
  ]) {
    expect(await (await fetch(origin + path)).text()).toBe(body);
  }
  expect((await fetch(origin + "/assets/missing")).status).toBe(404);
  expect((await fetch(origin + "/missing", { method: "POST" })).status).toBe(404);
  const gzip = await fetch(origin + "/sample.txt", { headers: { "accept-encoding": "gzip" } });
  expect(gzip.headers.get("content-encoding")).toBe("gzip");
  expect(await gzip.text()).toBe("abcdefgh");
});

it("serves public association files and keeps missing ones out of the SPA fallback", async () => {
  const res = await fetch(origin + "/.well-known/assetlinks.json");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(await res.json()).toEqual([]);
  expect((await fetch(origin + "/.well-known/missing.json")).status).toBe(404);
});

it("checks validators before ranges for both GET and HEAD", async () => {
  for (const method of ["GET", "HEAD"]) {
    const res = await fetch(origin + "/sample.txt", {
      method,
      headers: { "accept-encoding": "identity", "if-none-match": "*", range: "bytes=0-0" },
    });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  }
});

it("uses the modification time and size of the negotiated compressed file", async () => {
  const headers = { "accept-encoding": "gzip;q=0.8, identity;q=0.2" };
  const head = await fetch(origin + "/sample.txt", { method: "HEAD", headers });
  expect(head.headers.get("content-encoding")).toBe("gzip");
  expect(head.headers.get("content-type")).toContain("text/plain");
  expect(head.headers.get("vary")).toContain("Accept-Encoding");
  expect(Number(head.headers.get("content-length"))).toBe(gzipSync("abcdefgh").length);
  const cached = await fetch(origin + "/sample.txt", {
    headers: { ...headers, "if-modified-since": head.headers.get("last-modified")! },
  });
  expect(cached.status).toBe(304);
});

it.each([
  ["bytes=0-0", "", 206, "bytes 0-0/8", "a"],
  ["bytes=-3", "", 206, "bytes 5-7/8", "fgh"],
  ["Bytes=0-1", "", 206, "bytes 0-1/8", "ab"],
  ["bytes=8-", "", 416, "bytes */8", ""],
  ["bytes=0-1,5-6", "", 200, null, "abcdefgh"],
  ["bytes=2-4", '"old"', 200, null, "abcdefgh"],
  ["bytes=2-4", modified.toUTCString(), 206, "bytes 2-4/8", "cde"],
  ["bytes=2-4", "Tue, 31 Dec 2024 00:00:00 GMT", 200, null, "abcdefgh"],
  ["bytes=2-4", "Thu, 02 Jan 2025 00:00:00 GMT", 200, null, "abcdefgh"],
] as const)(
  "serves the selected bytes for %s with validator %s",
  async (range, validator, status, contentRange, body) => {
    const headers = new Headers({ range, "accept-encoding": "identity" });
    if (validator) headers.set("if-range", validator);
    const response = await fetch(origin + "/sample.txt", { headers });
    expect(response.status).toBe(status);
    expect(response.headers.get("content-range")).toBe(contentRange);
    expect(await response.text()).toBe(body);
  },
);
