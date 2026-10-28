// @vitest-environment node
import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";

import { logStreamErrors, requestLogger, resolveLogLevel } from "./logger.ts";

function createTestApp() {
  const lines: Record<string, unknown>[] = [];
  const base = pino(
    { formatters: { level: (label) => ({ level: label }) } },
    {
      write: (line: string) => {
        const entry: Record<string, unknown> = JSON.parse(line);
        lines.push(entry);
      },
    },
  );
  const app = new Hono()
    .use(requestId())
    .use(requestLogger(base))
    .get("/items", (c) => {
      c.var.logger.info("listing items");
      return c.json([]);
    })
    .get("/missing", (c) => c.notFound())
    .get("/broken", () => {
      throw new Error("boom");
    })
    .get("/aborted", (c) => c.text("Internal Server Error", 500));
  return { app, lines };
}

describe("requestLogger", () => {
  it("logs completed requests without the query string, under the request ID", async () => {
    const { app, lines } = createTestApp();

    await app.request("/items?token=secret", { headers: { "x-request-id": "req-1" } });

    expect(lines).toEqual([
      expect.objectContaining({ level: "info", requestId: "req-1", msg: "listing items" }),
      expect.objectContaining({
        level: "info",
        requestId: "req-1",
        method: "GET",
        path: "/items",
        status: 200,
        msg: "request completed",
      }),
    ]);
    expect(JSON.stringify(lines)).not.toContain("secret");
  });

  it("logs 4xx as info", async () => {
    const { app, lines } = createTestApp();

    await app.request("/missing");

    expect(lines).toEqual([expect.objectContaining({ level: "info", status: 404 })]);
  });

  it("logs 5xx as error with the error", async () => {
    const { app, lines } = createTestApp();

    await app.request("/broken");

    expect(lines).toEqual([
      expect.objectContaining({
        level: "error",
        status: 500,
        err: expect.objectContaining({ message: "boom" }),
        msg: "request failed",
      }),
    ]);
  });
});

describe("requestLogger with aborted requests", () => {
  it("logs requests the client aborted as info, even when they end in a 500", async () => {
    const { app, lines } = createTestApp();
    const controller = new AbortController();
    controller.abort();

    await app.request(new Request("http://localhost/aborted", { signal: controller.signal }));

    expect(lines).toEqual([expect.objectContaining({ level: "info", status: 500, msg: "request aborted" })]);
  });
});

describe("resolveLogLevel", () => {
  it("uses the default for NODE_ENV when LOG_LEVEL is unset or empty", () => {
    expect(resolveLogLevel(undefined, "production")).toBe("warn");
    expect(resolveLogLevel("", "production")).toBe("warn");
    expect(resolveLogLevel(undefined, "test")).toBe("silent");
    expect(resolveLogLevel(undefined, "development")).toBe("debug");
    // Unset counts as production: hosts that mount the app need not set NODE_ENV.
    expect(resolveLogLevel(undefined, undefined)).toBe("warn");
    expect(resolveLogLevel(undefined, "staging")).toBe("warn");
  });

  it("uses a valid LOG_LEVEL", () => {
    expect(resolveLogLevel("info", "production")).toBe("info");
    expect(resolveLogLevel("silent", "development")).toBe("silent");
  });

  it("rejects an unknown LOG_LEVEL with the valid ones", () => {
    expect(() => resolveLogLevel("verbose", "production")).toThrow(
      'Invalid LOG_LEVEL "verbose": expected one of trace, debug, info, warn, error, fatal, silent',
    );
  });
});

function captureLogs() {
  const lines: Record<string, unknown>[] = [];
  const base = pino(
    { formatters: { level: (label) => ({ level: label }) } },
    {
      write: (line: string) => {
        const entry: Record<string, unknown> = JSON.parse(line);
        lines.push(entry);
      },
    },
  );
  return { lines, base };
}

describe("logStreamErrors", () => {
  it("passes the body through unchanged", async () => {
    const { lines, base } = captureLogs();
    const abort = vi.fn<() => void>();

    const response = logStreamErrors(new Response("hello", { status: 201 }), abort, base);

    expect([response.status, await response.text()]).toEqual([201, "hello"]);
    expect(abort).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it("stays quiet when the client cancels while a read is pending", async () => {
    const { lines, base } = captureLogs();
    const abort = vi.fn<() => void>();
    let push: ((chunk: Uint8Array) => void) | undefined;
    const slow = new ReadableStream<Uint8Array>({
      pull: (controller) =>
        new Promise<void>((resolve) => {
          push = (chunk) => {
            // The source may already be cancelled by then, like a real one finishing late.
            try {
              controller.enqueue(chunk);
            } catch {}
            resolve();
          };
        }),
    });
    const reader = logStreamErrors(new Response(slow), abort, base).body?.getReader();

    const pending = reader?.read();
    // Let the wrapper start reading the source before the client goes away.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await reader?.cancel("client went away");
    push?.(new TextEncoder().encode("late"));
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(abort).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it("logs a failing stream with the request ID and aborts the connection", async () => {
    const { lines, base } = captureLogs();
    const abort = vi.fn<() => void>();
    let pulls = 0;
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode("partial"));
        else controller.error(new Error("stream broke"));
      },
    });

    const response = logStreamErrors(new Response(failing, { headers: { "x-request-id": "req-1" } }), abort, base);

    expect(await response.text()).toBe("partial");
    expect(abort).toHaveBeenCalledOnce();
    expect(lines).toEqual([
      expect.objectContaining({
        level: "error",
        requestId: "req-1",
        err: expect.objectContaining({ message: "stream broke" }),
        msg: "response stream failed",
      }),
    ]);
  });
});
