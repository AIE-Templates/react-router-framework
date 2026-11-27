// @vitest-environment node
import { logger } from "@repo/server";
import { cookieName, visualRecordKernel } from "@repo/shared";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiContext } from "~/lib/api";
import { loggerContext } from "~/lib/logger";

import { createHostApp, createLoadContext, getHostApp } from "./app";
import { defaultPolicy } from "./csp";

// Supply the build that the Router Vite plugin normally generates. Both response types
// go through the real request handler and the host's load context.
vi.mock("virtual:react-router/server-build", async () => {
  const { loader } = await import("~/root");
  return {
    ssr: true,
    basename: "/",
    routeDiscovery: { mode: "initial", manifestPath: "/__manifest" },
    future: {},
    assets: {},
    routes: { root: { id: "root", path: "/settings", module: { loader, default: () => null } } },
    entry: {
      module: {
        default: (_request: Request, status: number) =>
          new Response("<html></html>", { status, headers: { "Content-Type": "text/html" } }),
      },
    },
    unstable_apiOnly: false,
    unstable_apiServerOrigin: undefined,
    unstable_getCriticalCss: undefined,
  };
});

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

  it("leaves cache headers of SSR documents and data to the application, like React Router", async () => {
    const app = createHostApp({ csp: defaultPolicy(false) });
    const headers = {
      Cookie:
        cookieName("visual") +
        "=" +
        encodeURIComponent(
          visualRecordKernel.encode({ version: 1, stamp: { t: 1, id: "a" }, preferences: { direction: "rtl" } }),
        ),
    };
    for (const path of ["/settings", "/settings.data"]) {
      const response = await app.request(path, { headers });
      expect(response.status).toBe(200);
      expect(response.headers.has("cache-control")).toBe(false);
    }
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

describe("createLoadContext", () => {
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
