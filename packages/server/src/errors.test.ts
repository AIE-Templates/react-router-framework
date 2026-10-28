// @vitest-environment node
import { Hono } from "hono";
import { streamText } from "hono/streaming";
import { pino } from "pino";
import { describe, expect, it } from "vitest";

import { logStreamFailure, rethrowNonErrors, wrapThrownValues } from "./errors.ts";
import { requestLogger } from "./logger.ts";

describe("wrapThrownValues", () => {
  it("turns a thrown string into an Error that reaches onError", async () => {
    const errors: unknown[] = [];
    const app = new Hono()
      .use(wrapThrownValues())
      .get("/", () => {
        // What fetch rejects with when @hono/node-server aborts the request's signal.
        throw "Client connection prematurely closed.";
      })
      .onError((err, c) => {
        errors.push(err);
        return c.text("Internal Server Error", 500);
      });

    const response = await app.request("/");

    expect(response.status).toBe(500);
    expect(errors).toEqual([expect.objectContaining({ message: "Client connection prematurely closed." })]);
  });
});

function createStreamApp(failure: unknown) {
  const lines: string[] = [];
  const base = pino({}, { write: (line: string) => lines.push(line) });
  const app = new Hono().use(requestLogger(base)).get("/", (c) =>
    streamText(
      c,
      rethrowNonErrors(async (stream) => {
        await stream.write("partial");
        throw failure;
      }),
      logStreamFailure(c),
    ),
  );
  return { app, lines };
}

describe("streaming helpers", () => {
  it("logs a non-Error thrown in the stream with the request's logger", async () => {
    const { app, lines } = createStreamApp("upstream went away");

    await (await app.request("/")).text();

    expect(lines.filter((line) => line.includes("stream failed"))).toEqual([
      expect.stringContaining("upstream went away"),
    ]);
  });

  it("skips errors once the client has disconnected", async () => {
    const { app, lines } = createStreamApp(new Error("aborted"));
    const controller = new AbortController();
    controller.abort();

    await (await app.request(new Request("http://localhost/", { signal: controller.signal }))).text();

    expect(lines.filter((line) => line.includes("stream failed"))).toEqual([]);
  });
});
