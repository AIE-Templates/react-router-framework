// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, expect, it } from "vitest";

import { createStaticApp } from "../serve";

const root = mkdtempSync(join(tmpdir(), "static-client-"));
mkdirSync(join(root, "docs"));
writeFileSync(join(root, "docs/index.html"), "docs");
writeFileSync(join(root, "index.html"), "home");
writeFileSync(join(root, "__spa-fallback.html"), "shell");
writeFileSync(join(root, "sample.txt"), "abcdefgh");
const modified = new Date("2025-01-01T00:00:00Z");
utimesSync(join(root, "sample.txt"), modified, modified);
writeFileSync(join(root, "sample.txt.gz"), gzipSync("abcdefgh"));
const server = createStaticApp(root).listen(0, "127.0.0.1");
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

it.each([
  ["bytes=0-0", "", 206, "bytes 0-0/8", "a"],
  ["bytes=-3", "", 206, "bytes 5-7/8", "fgh"],
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
