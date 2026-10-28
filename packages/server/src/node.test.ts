// @vitest-environment node
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createServerApp } from "./app.ts";
import { startServer, type RunningServer } from "./node.ts";

const silent = pino({ level: "silent" });
const app = createServerApp({ logger: silent });
const options = { host: "127.0.0.1", port: 0, logger: silent, handleSignals: false };

let server: RunningServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("startServer", () => {
  it("serves the app and reports where", async () => {
    server = await startServer(app, options);

    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${server.url}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("takes the origin from forwarded headers when trusting the proxy", async () => {
    server = await startServer(app, { ...options, trustProxy: true });
    // A form-like POST from the public origin, as the proxy forwards it.
    const post = (headers: Record<string, string>) =>
      fetch(`${server!.url}/api/health`, {
        method: "POST",
        headers: { "content-type": "text/plain", origin: "https://public.example", ...headers },
        body: "{}",
      });

    // Without the forwarded headers, the request looks cross-site to the CSRF check.
    expect((await post({})).status).toBe(403);
    // With them, it is same-origin and reaches the API (no POST route, hence 404).
    expect((await post({ "x-forwarded-proto": "https", "x-forwarded-host": "public.example" })).status).toBe(404);
  });

  it("rejects an invalid port", async () => {
    await expect(startServer(app, { ...options, port: "abc" })).rejects.toThrow('Invalid PORT "abc"');
  });

  it("installs no signal handlers for a server that failed to start", async () => {
    const before = [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")];

    await expect(startServer(app, { ...options, handleSignals: true, port: "abc" })).rejects.toThrow("Invalid PORT");

    expect([process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")]).toEqual(before);
  });

  it("closes every server on a signal before exiting, and waits for the drain on a second signal", async () => {
    const listeners = { SIGTERM: process.listeners("SIGTERM"), SIGINT: process.listeners("SIGINT") };
    const exited = { resolve: () => {}, promise: Promise.resolve() };
    exited.promise = new Promise<void>((resolve) => void (exited.resolve = resolve));
    // process.exit() returns `never`, which no stub can; the cast is the only way to stub it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const exit = vi.spyOn(process, "exit").mockImplementation((() => exited.resolve()) as typeof process.exit);
    const first = await startServer(app, { ...options, handleSignals: true });
    const second = await startServer(app, { ...options, handleSignals: true });
    try {
      // Installed once, after each server is listening.
      expect(process.listenerCount("SIGTERM")).toBe(listeners.SIGTERM.length + 1);
      const closed = { first: false, second: false };
      first.httpServer.once("close", () => (closed.first = true));
      second.httpServer.once("close", () => (closed.second = true));
      const requested = new Promise<void>((resolve) => void first.httpServer.on("request", () => resolve()));
      // An in-flight request: a signal must not exit until it is done.
      const slow = fetch(`${first.url}/api/health`);
      await requested;
      process.emit("SIGTERM");
      // The other kind of signal while draining must not exit early either.
      process.emit("SIGINT");

      expect((await slow).status).toBe(200);
      await exited.promise;
      expect(closed).toEqual({ first: true, second: true });
      expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    } finally {
      await Promise.all([first.close(), second.close()]);
      for (const signal of ["SIGTERM", "SIGINT"] as const) {
        for (const listener of process.listeners(signal)) {
          if (!listeners[signal].includes(listener)) process.off(signal, listener);
        }
      }
    }
  });

  it("runs two servers in one process", async () => {
    server = await startServer(app, options);
    const second = await startServer(app, options);
    try {
      expect(second.url).not.toBe(server.url);
      await second.close();
      // Closing one leaves the other serving.
      expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
    } finally {
      await second.close();
    }
  });
});
