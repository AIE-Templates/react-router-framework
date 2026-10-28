// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { defaultPolicy } from "./csp";
import { createWebApp } from "./web-app";

const SHELL =
  "<!DOCTYPE html><html><body><div id=root></div><script>window.__shell=1</script><script src=/assets/app.js></script></body></html>";
// Above compress()'s threshold, so the response is compressed when asked.
const ASSET = `console.log(${JSON.stringify("x".repeat(2000))});`;
const lastModified = new Date("2026-01-01T00:00:00Z");

// A client build, as `react-router build` lays it out. Created up front: the apps below are built
// when their describe blocks run.
const clientDir = mkdtempSync(join(tmpdir(), "web-client-"));
mkdirSync(join(clientDir, "assets"));
mkdirSync(join(clientDir, "about"));
mkdirSync(join(clientDir, "manual.html"));
mkdirSync(join(clientDir, "version.v1"));
for (const [file, contents] of [
  ["index.html", SHELL],
  ["about/index.html", "<p>prerendered</p>"],
  ["favicon.ico", "icon"],
  ["assets/app.js", ASSET],
  ["assets/page.html", "<script>alert(1)</script>"],
  ["page.htm", "<script>alert(2)</script>"],
  ["page.HTML", "<script>alert(3)</script>"],
  ["manual.html/index.html", "<script>alert(4)</script>"],
  ["version.v1/index.html", "<script>alert(5)</script>"],
] as const) {
  writeFileSync(join(clientDir, file), contents);
  utimesSync(join(clientDir, file), lastModified, lastModified);
}
afterAll(() => rm(clientDir, { recursive: true, force: true }));
afterEach(() => {
  vi.restoreAllMocks();
});

describe("static files", () => {
  const web = createWebApp({ clientDir, ssr: true });

  it("serves assets immutable and compressed, through the server's middleware", async () => {
    const response = await web.request("/assets/app.js", { headers: { "accept-encoding": "gzip" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("serves other files for an hour and documents with no-cache", async () => {
    expect((await web.request("/favicon.ico")).headers.get("cache-control")).toBe("public, max-age=3600");
    // A prerendered page: extensionless path, served from about/index.html.
    const page = await web.request("/about");
    expect(await page.text()).toBe("<p>prerendered</p>");
    expect(page.headers.get("cache-control")).toBe("no-cache");
  });

  it("answers revalidation of an unchanged file with 304", async () => {
    const response = await web.request("/favicon.ico", {
      headers: { "if-modified-since": new Date("2026-02-01T00:00:00Z").toUTCString() },
    });

    expect(response.status).toBe(304);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(response.headers.has("content-length")).toBe(false);
    const changed = await web.request("/favicon.ico", {
      headers: { "if-modified-since": new Date("2025-01-01T00:00:00Z").toUTCString() },
    });
    expect(changed.status).toBe(200);
  });

  it("serves the API", async () => {
    const response = await web.request("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});

describe("without server rendering", () => {
  const web = createWebApp({ clientDir, ssr: false });

  it("serves the SPA shell for every page, with a request ID", async () => {
    for (const path of ["/", "/some/deep/route", "/about/team"]) {
      const response = await web.request(path, { headers: { "x-request-id": "req-1" } });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(SHELL);
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(response.headers.get("x-request-id")).toBe("req-1");
    }
    // Prerendered pages still win.
    expect(await (await web.request("/about")).text()).toBe("<p>prerendered</p>");
  });

  it("allows the shell's inline scripts by hash in its Content-Security-Policy", async () => {
    // The production policy: under Vitest `import.meta.env.DEV` would pick the development one.
    const production = createWebApp({ clientDir, ssr: false, csp: defaultPolicy(false) });
    const response = await production.request("/some/deep/route");

    const header = response.headers.get("content-security-policy") ?? "";
    const hash = createHash("sha256").update("window.__shell=1").digest("base64");
    expect(header).toContain(`script-src 'self' 'sha256-${hash}'`);
    expect(header).toContain("frame-ancestors 'none'");
    // The same shell served as a static file (`/` and `/index.html`) carries the same policy, and a
    // prerendered page gets one for its own inline scripts (none here).
    for (const path of ["/", "/index.html"]) {
      const served = await production.request(path);
      expect(served.headers.get("content-security-policy")).toBe(header);
      expect(await served.text()).toBe(SHELL);
    }
    const prerendered = await production.request("/about");
    expect(prerendered.headers.get("content-security-policy")).toContain("script-src 'self';");
    expect(await prerendered.text()).toBe("<p>prerendered</p>");
    // HEAD carries the same policy as GET (the hashes come from the file, not the response body),
    // documents never serve byte ranges, and HTML under /assets is a document too.
    const head = await production.request("/", { method: "HEAD" });
    expect(head.headers.get("content-security-policy")).toBe(header);
    const ranged = await production.request("/", { headers: { range: "bytes=0-" } });
    expect(ranged.status).toBe(200);
    expect(ranged.headers.get("content-security-policy")).toBe(header);
    const underAssets = await production.request("/assets/page.html");
    expect(underAssets.status).toBe(200);
    expect(underAssets.headers.get("content-security-policy")).toContain("'sha256-");
    // Every HTML file serveStatic can resolve gets a policy with its own hash, for GET, HEAD and a
    // Range request alike: .htm, upper-case extensions, directories with dots in their names.
    for (const [path, script] of [
      ["/page.htm", "alert(2)"],
      ["/page.HTML", "alert(3)"],
      ["/manual.html", "alert(4)"],
      ["/version.v1", "alert(5)"],
    ] as const) {
      const expected = `'sha256-${createHash("sha256").update(script).digest("base64")}'`;
      const get = await production.request(path);
      expect([path, get.status]).toEqual([path, 200]);
      expect(get.headers.get("content-security-policy")).toContain(expected);
      const headResponse = await production.request(path, { method: "HEAD" });
      expect(headResponse.headers.get("content-security-policy")).toBe(get.headers.get("content-security-policy"));
      const rangeRequest = await production.request(path, { headers: { range: "bytes=0-" } });
      expect([path, rangeRequest.status]).toEqual([path, 200]);
      expect(rangeRequest.headers.get("content-security-policy")).toContain(expected);
    }
    // Opting out removes it.
    const bare = createWebApp({ clientDir, ssr: false, csp: false });
    expect((await bare.request("/")).headers.has("content-security-policy")).toBe(false);
  });

  it("leaves the API to the server, unknown paths included", async () => {
    expect(await (await web.request("/api/health")).json()).toEqual({ status: "ok" });
    for (const path of ["/api", "/api/missing"]) {
      const response = await web.request(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Not Found" });
    }
  });

  it("passes a POST straight through, Range header and body untouched", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The static layer sees the POST first: it must neither serve index.html nor touch the request
    // (removing Range on an immutable-header request would copy it and drop the body).
    const request = new Request("http://localhost/", {
      method: "POST",
      headers: { range: "bytes=0-" },
      body: "payload",
    });
    const response = await web.fetch(request);

    expect(response.status).toBe(500);
    expect(await response.text()).not.toBe(SHELL);
    expect(request.headers.get("range")).toBe("bytes=0-");
    expect(request.bodyUsed).toBe(false);
  });

  it("leaves non-GET requests and .data requests to the app", async () => {
    // The app's React Router handler needs the server build, which tests stub with an error: reaching
    // it shows as a 500 (logged to the console in tests).
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [path, init] of [
      ["/some/route", { method: "POST" }],
      ["/some/route.data", undefined],
    ] as const) {
      const response = await web.request(path, init);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toBe(SHELL);
    }
  });

  it("answers with a 500 while the shell is unreadable, then recovers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const emptyDir = mkdtempSync(join(tmpdir(), "web-client-empty-"));
    try {
      const broken = createWebApp({ clientDir: emptyDir, ssr: false });
      // A deep path: `/` would be served from index.html as a static file once it exists.
      // Through the server's error handling: a plain 500, not Hono's default.
      const failed = await broken.request("/some/route");
      expect(failed.status).toBe(500);
      expect(await failed.text()).toBe("Internal Server Error");

      writeFileSync(join(emptyDir, "index.html"), SHELL);
      const recovered = await broken.request("/some/route");
      expect(recovered.status).toBe(200);
      expect(await recovered.text()).toBe(SHELL);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("with server rendering", () => {
  it("leaves pages to React Router", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const web = createWebApp({ clientDir, ssr: true });

    const response = await web.request("/some/route");

    expect(response.status).toBe(500);
    expect(await response.text()).not.toBe(SHELL);
  });
});

// What reaches React Router, seen from a server that mounts the web app (as the README shows):
// after next(), c.req.raw and c.var are what the React Router handler got (it fails in tests, with
// the server build stubbed).
async function seenByReactRouter(web: Hono) {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let seen: { shell: unknown; desktop: unknown; titlebar: string | null } | undefined;
  const gateway = new Hono();
  gateway.use(async (c, next) => {
    await next();
    seen = { shell: c.var.shell, desktop: c.var.desktop, titlebar: c.req.raw.headers.get("x-desktop-titlebar") };
  });
  gateway.route("/", web);
  await gateway.request("/some/route", {
    headers: { "x-desktop-titlebar": "custom", "x-desktop-fullscreen": "1" },
  });
  return seen;
}

describe("shell", () => {
  it("is web by default, and strips desktop headers", async () => {
    expect(await seenByReactRouter(createWebApp({ clientDir, ssr: true }))).toEqual({
      shell: { kind: "web" },
      desktop: undefined,
      titlebar: null,
    });
    expect(await seenByReactRouter(createWebApp({ clientDir, ssr: true, shell: { kind: "web" } }))).toMatchObject({
      shell: { kind: "web" },
      titlebar: null,
    });
  });

  it("in the desktop shell, reads desktop headers", async () => {
    const shell = { kind: "desktop", platform: "win32", osVersion: "10.0.26100" } as const;

    expect(await seenByReactRouter(createWebApp({ clientDir, ssr: true, shell }))).toEqual({
      shell,
      desktop: { titlebar: "custom", chromeMode: "system-decorated", fullscreen: true, prefs: {} },
      titlebar: "custom",
    });
  });

  it("serves static files and the API in both shells", async () => {
    for (const shell of [{ kind: "web" }, { kind: "desktop", platform: "linux", osVersion: "6.8" }] as const) {
      const web = createWebApp({ clientDir, ssr: false, shell });
      expect(await (await web.request("/favicon.ico")).text()).toBe("icon");
      expect(await (await web.request("/api/health")).json()).toEqual({ status: "ok" });
      expect(await (await web.request("/some/route", { headers: { "x-desktop-titlebar": "custom" } })).text()).toBe(
        SHELL,
      );
    }
  });
});

describe("extend", () => {
  it("registers a host's routes before static files and React Router, through the server's middleware", async () => {
    const web = createWebApp({
      clientDir,
      ssr: false,
      extend: (app) => {
        app.get("/favicon.ico", (c) => c.text("from extend"));
        app.get("/__host/ping", (c) => c.json({ requestId: c.var.requestId }));
      },
    });

    expect(await (await web.request("/favicon.ico")).text()).toBe("from extend");
    const response = await web.request("/__host/ping");
    expect(await response.json()).toEqual({ requestId: response.headers.get("x-request-id") });
    expect(await (await web.request("/api/health")).json()).toEqual({ status: "ok" });
    expect(await (await web.request("/some/route")).text()).toBe(SHELL);
  });
});
