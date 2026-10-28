import { describe, expect, it } from "vitest";

import { withBenchRoutes } from "./bench-routes.ts";

const origin = "http://app.desktop";
const handler = withBenchRoutes(
  () => new Response("app"),
  () => undefined,
);

describe("withBenchRoutes", () => {
  it("passes everything outside /__bench/ to the app", async () => {
    expect(await (await handler(new Request(`${origin}/api/health`))).text()).toBe("app");
  });

  it("streams n bytes in chunks of the requested size", async () => {
    const response = await handler(new Request(`${origin}/__bench/bytes?n=100000&chunk=30000`));
    expect(response.headers.get("content-length")).toBe("100000");
    const sizes: number[] = [];
    for await (const chunk of response.body!) sizes.push(chunk.byteLength);
    expect(sizes).toEqual([30000, 30000, 30000, 10000]);
  });

  it("rejects a missing or out-of-range size", async () => {
    expect((await handler(new Request(`${origin}/__bench/bytes`))).status).toBe(400);
    expect((await handler(new Request(`${origin}/__bench/bytes?n=-1`))).status).toBe(400);
    expect((await handler(new Request(`${origin}/__bench/bytes?n=10&chunk=0`))).status).toBe(400);
  });

  it("counts an upload", async () => {
    const response = await handler(
      new Request(`${origin}/__bench/upload`, { method: "POST", body: new Uint8Array(12345) }),
    );
    expect(await response.json()).toEqual({ bytes: 12345 });
  });

  it("reports the process", async () => {
    const proc: unknown = await (await handler(new Request(`${origin}/__bench/proc`))).json();
    expect(proc).toMatchObject({ cpu: { user: expect.any(Number) }, memory: { rss: expect.any(Number) } });
  });

  it("answers 404 for unknown bench routes", async () => {
    expect((await handler(new Request(`${origin}/__bench/nope`))).status).toBe(404);
  });
});
