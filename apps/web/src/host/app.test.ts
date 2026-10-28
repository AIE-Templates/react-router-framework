// @vitest-environment node
import { createAdaptorServer } from "@hono/node-server";
import { logger } from "@repo/server";
import type { Shell } from "@repo/shared";
import type { Hono } from "hono";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiContext } from "~/lib/api";
import { loggerContext } from "~/lib/logger";
import { getPreference, preferencesContext } from "~/lib/preferences";
import { desktopContext, shellContext } from "~/lib/shell";

import { createHostApp, createLoadContext, getHostApp } from "./app";

const desktop: Shell = { kind: "desktop", platform: "darwin", osVersion: "26.1" };

const desktopHeaders = {
  "x-desktop-titlebar": "custom",
  "X-Desktop-Fullscreen": "1",
  "x-desktop-prefs": JSON.stringify({ theme: "dark" }),
  "x-desktop-unknown": "yes",
};

/**
 * What reaches React Router: `extend` middleware runs before the shell middleware, so after `next()`
 * it sees the request and variables the React Router handler was called with. The handler itself
 * fails in tests (the server build is stubbed), which doesn't matter here.
 */
function observe(shell?: Shell) {
  const seen: { headers?: Headers; shell?: Shell; desktop?: unknown; raw?: Request }[] = [];
  const app: Hono = createHostApp({
    shell,
    extend: (host) =>
      host.use(async (c, next) => {
        await next();
        seen.push({ headers: c.req.raw.headers, shell: c.var.shell, desktop: c.var.desktop, raw: c.req.raw });
      }),
  });
  return { app, seen };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("host app", () => {
  it("serves the API", async () => {
    const response = await getHostApp().request("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("is built once, while createHostApp() builds a new one each time", () => {
    expect(getHostApp()).toBe(getHostApp());
    expect(createHostApp()).not.toBe(getHostApp());
  });

  it("runs middleware from `extend` after the API and before React Router", async () => {
    const seen: string[] = [];
    const app = createHostApp({
      extend: (host) => {
        host.use(async (c, next) => {
          seen.push(c.req.path);
          await next();
        });
        host.get("/extra", (c) => c.text("extra"));
      },
    });

    expect(await (await app.request("/extra")).text()).toBe("extra");
    // The API answered first, so the middleware never saw it.
    expect(await (await app.request("/api/health")).json()).toEqual({ status: "ok" });
    expect(seen).toEqual(["/extra"]);
  });
});

describe("shell", () => {
  it("is web by default, and strips every x-desktop-* header before React Router", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, seen } = observe();

    await app.request("/page", { headers: { ...desktopHeaders, "x-other": "kept" } });

    const [{ headers, shell, desktop: request } = {}] = seen;
    expect(shell).toEqual({ kind: "web" });
    expect(request).toBeUndefined();
    expect([...headers!.keys()].filter((name) => name.startsWith("x-desktop-"))).toEqual([]);
    expect(headers!.get("x-other")).toBe("kept");
  });

  it("strips them in place, from the request React Router gets", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, seen } = observe();
    const request = new Request("http://localhost/page", { headers: { "x-desktop-titlebar": "custom" } });

    await app.request(request);

    expect(seen[0]?.raw).toBe(request);
    expect(request.headers.has("x-desktop-titlebar")).toBe(false);
  });

  it("copies a request whose headers are immutable, keeping its method, body and abort signal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, seen } = observe();
    const controller = new AbortController();
    const request = new Request("http://localhost/page", {
      method: "POST",
      headers: { "x-desktop-titlebar": "custom", "content-type": "text/plain" },
      body: "hello",
      signal: controller.signal,
    });
    // As on runtimes whose incoming requests have immutable headers.
    const immutable = new Headers(request.headers);
    immutable.delete = () => {
      throw new TypeError("immutable");
    };
    Object.defineProperty(request, "headers", { value: immutable });

    await app.request(request);

    const raw = seen[0]?.raw;
    expect(raw).not.toBe(request);
    expect(raw?.method).toBe("POST");
    expect(raw?.headers.has("x-desktop-titlebar")).toBe(false);
    expect(raw?.headers.get("content-type")).toBe("text/plain");
    expect(await raw?.text()).toBe("hello");
    expect(raw?.signal.aborted).toBe(false);
    controller.abort();
    expect(raw?.signal.aborted).toBe(true);
  });

  it("strips them from requests served by @hono/node-server", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, seen } = observe();
    // As startServer() serves: without replacing the Request global.
    const server = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      const port = typeof address === "object" ? address?.port : undefined;
      for (const method of ["GET", "POST"]) {
        await fetch(`http://127.0.0.1:${port}/page`, {
          method,
          headers: { "x-desktop-titlebar": "custom", "x-other": "kept" },
          body: method === "POST" ? "a=1" : undefined,
        });
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    expect(seen.map(({ headers }) => [headers?.get("x-desktop-titlebar"), headers?.get("x-other")])).toEqual([
      [null, "kept"],
      [null, "kept"],
    ]);
  });

  it("in the desktop shell, parses the x-desktop-* headers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, seen } = observe(desktop);

    await app.request("/page", { headers: desktopHeaders });

    expect(seen[0]?.shell).toEqual(desktop);
    expect(seen[0]?.desktop).toEqual({
      titlebar: "custom",
      chromeMode: "system-decorated",
      fullscreen: true,
      prefs: { theme: "dark" },
    });
    expect(seen[0]?.headers?.get("x-desktop-titlebar")).toBe("custom");
  });

  it("in the desktop shell, defaults the per-request facts without headers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, seen } = observe(desktop);

    await app.request("/page");

    expect(seen[0]?.desktop).toEqual({
      titlebar: "native",
      chromeMode: "system-decorated",
      fullscreen: false,
      prefs: {},
    });
  });
});

describe("createLoadContext", () => {
  it("gives loaders the shell and the desktop facts, web and none by default", () => {
    const web = createLoadContext(new Request("https://example.com/"));
    expect(web.get(shellContext)).toEqual({ kind: "web" });
    expect(web.get(desktopContext)).toBeUndefined();

    const facts = { titlebar: "custom", chromeMode: "system-decorated", fullscreen: false, prefs: {} } as const;
    const context = createLoadContext(new Request("https://example.com/"), { shell: desktop, desktop: facts });
    expect(context.get(shellContext)).toBe(desktop);
    expect(context.get(desktopContext)).toBe(facts);
  });

  it("gives loaders the preferences of the shell it was started with, never of the request", () => {
    const request = new Request("https://example.com/", {
      headers: { cookie: "pref-theme=%22light%22; other=1", "x-desktop-prefs": JSON.stringify({ theme: "dark" }) },
    });
    const web = createLoadContext(request);
    expect(web.get(preferencesContext)).toEqual({ theme: "light" });
    expect(getPreference(web, "theme")).toBe("light");

    const facts = {
      titlebar: "native",
      chromeMode: "system-decorated",
      fullscreen: false,
      prefs: { theme: "dark" },
    } as const;
    const context = createLoadContext(request, { shell: desktop, desktop: facts });
    expect(context.get(preferencesContext)).toEqual({ theme: "dark" });
    expect(createLoadContext(request, { shell: desktop }).get(preferencesContext)).toEqual({});
  });

  it("gives loaders a client that calls the API in-process, under the request's ID", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const context = createLoadContext(new Request("https://example.com/page"), { requestId: "req-1" });

    const response = await context.get(apiContext).api.health.$get();

    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("x-request-id")).toBe("req-1");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("gives loaders the request's logger, or the app's", () => {
    const requestLogger = pino({ level: "silent" });

    expect(createLoadContext(new Request("https://example.com/"), { logger: requestLogger }).get(loggerContext)).toBe(
      requestLogger,
    );
    expect(createLoadContext(new Request("https://example.com/")).get(loggerContext)).toBe(logger);
  });
});
