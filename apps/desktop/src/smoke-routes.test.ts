import { createServerApp, logger, logStreamFailure, rethrowNonErrors } from "@repo/server";
import { describe, expect, it } from "vitest";

import { SMOKE_PREFIX, smokeRoutes, type SmokeStreamStatus } from "./smoke-routes.ts";

const origin = "http://app.desktop";

function createApp() {
  // Mounted the way the utility mounts it: inside the server's chain, which sets `c.var.logger`.
  const app = createServerApp({ logger: logger.child({}, { level: "silent" }) });
  app.route(SMOKE_PREFIX, smokeRoutes({ rethrowNonErrors, logStreamFailure }));
  return app;
}

async function status(app: ReturnType<typeof createApp>, id: string): Promise<SmokeStreamStatus> {
  const body: unknown = await (await app.fetch(new Request(`${origin}/__smoke/sse-status?id=${id}`))).json();
  if (!isStatus(body)) throw new Error(`not a stream status: ${JSON.stringify(body)}`);
  return body;
}

function isStatus(value: unknown): value is SmokeStreamStatus {
  return typeof value === "object" && value !== null && "events" in value && typeof value.events === "number";
}

describe("smokeRoutes", () => {
  it("streams the events one by one, then an end event, and reports the stream completed", async () => {
    const app = createApp();
    const started = performance.now();
    const response = await app.fetch(new Request(`${origin}/__smoke/sse?id=a&count=3&interval=40`));
    expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    const arrivals: number[] = [];
    let text = "";
    for await (const chunk of response.body!.pipeThrough(new TextDecoderStream())) {
      text += chunk;
      arrivals.push(performance.now() - started);
    }
    expect(text.match(/^id: \d+$/gm)).toEqual(["id: 0", "id: 1", "id: 2"]);
    expect(text).toContain("event: end\ndata: 3\n\n");
    // Spaced by the interval, not written at once.
    expect(arrivals.at(-1)! - arrivals[0]).toBeGreaterThanOrEqual(60);
    expect(await status(app, "a")).toEqual({ events: 3, aborted: false, completed: true });
  });

  it("sees the request's signal abort when the client cancels, and stops writing", async () => {
    const app = createApp();
    const controller = new AbortController();
    const response = await app.fetch(
      new Request(`${origin}/__smoke/sse?id=b&count=100&interval=20`, { signal: controller.signal }),
    );
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    const aborted = await status(app, "b");
    expect(aborted).toMatchObject({ aborted: true, completed: false });
    expect(aborted.abortedAfterMs).toEqual(expect.any(Number));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const settled = await status(app, "b");
    expect(settled.events).toBeLessThanOrEqual(aborted.events + 1);
    expect(settled.events).toBeLessThan(100);
  });

  it("rejects bad parameters and answers 404 for an unknown stream", async () => {
    const app = createApp();
    for (const query of [
      "count=3&interval=10",
      "id=a&count=0&interval=10",
      "id=a&count=3&interval=5000",
      "id=a b&count=1&interval=0",
    ])
      expect((await app.fetch(new Request(`${origin}/__smoke/sse?${query}`))).status).toBe(400);
    expect((await app.fetch(new Request(`${origin}/__smoke/sse-status?id=nope`))).status).toBe(404);
  });

  it("remembers only the latest streams", async () => {
    const app = createApp();
    for (let i = 0; i < 10; i++)
      await (await app.fetch(new Request(`${origin}/__smoke/sse?id=s${i}&count=1&interval=0`))).text();
    expect((await app.fetch(new Request(`${origin}/__smoke/sse-status?id=s0`))).status).toBe(404);
    expect(await status(app, "s9")).toMatchObject({ completed: true });
  });
});
