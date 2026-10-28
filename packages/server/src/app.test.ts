// @vitest-environment node
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { createServerApp, parseAllowedOrigins } from "./app.ts";

// A form-like POST to the API, as a browser or another site could send it.
function postToApi(app: Hono, headers: Record<string, string>) {
  return app.request("https://example.com/api/health", {
    method: "POST",
    headers: { "content-type": "text/plain", ...headers },
    body: "{}",
  });
}

describe("createServerApp", () => {
  const app = createServerApp();

  it("serves API routes", async () => {
    const response = await app.request("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("gives every response a request ID, reusing a valid incoming one", async () => {
    expect((await app.request("/api/health")).headers.get("x-request-id")).toMatch(/^[\w-]{8,}$/);
    expect(
      (await app.request("/api/health", { headers: { "x-request-id": "req-1" } })).headers.get("x-request-id"),
    ).toBe("req-1");
  });

  it("rejects paths with malformed percent-encoding", async () => {
    expect((await app.request("/%E0%A4%A")).status).toBe(400);
  });

  it("rejects cross-site form-like requests to the API", async () => {
    expect((await postToApi(app, { origin: "https://evil.example" })).status).toBe(403);
    expect((await postToApi(app, {})).status).toBe(403);
    // Same-origin requests pass the check and reach the API (this route has no POST, hence 404).
    expect((await postToApi(app, { origin: "https://example.com" })).status).toBe(404);
    expect((await postToApi(app, { "sec-fetch-site": "same-origin" })).status).toBe(404);
  });

  it("answers unknown API paths and methods with a JSON 404", async () => {
    for (const response of [
      await app.request("/api/nope"),
      await app.request("/api/health", { method: "POST", headers: { origin: "http://localhost" } }),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Not Found" });
    }
  });

  it("sends no CORS headers by default", async () => {
    const response = await app.request("/api/health", { headers: { origin: "https://app.example" } });

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("createServerApp with allowedOrigins", () => {
  const app = createServerApp({ allowedOrigins: ["https://app.example"] });

  it("answers preflight requests from allowed origins, with credentials", async () => {
    const response = await app.request("/api/health", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-allow-headers")).toBe("content-type");
  });

  it("sends CORS headers only to allowed origins", async () => {
    const allowed = await app.request("/api/health", { headers: { origin: "https://app.example" } });
    const other = await app.request("/api/health", { headers: { origin: "https://evil.example" } });

    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(allowed.headers.get("access-control-expose-headers")).toBe("X-Request-Id");
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("lets form-like requests from allowed origins and the API's own origin past the CSRF check", async () => {
    expect((await postToApi(app, { origin: "https://app.example" })).status).toBe(404);
    expect((await postToApi(app, { origin: "https://example.com" })).status).toBe(404);
    expect((await postToApi(app, { origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("parseAllowedOrigins", () => {
  it("returns undefined when unset or empty", () => {
    expect(parseAllowedOrigins(undefined)).toBeUndefined();
    expect(parseAllowedOrigins("")).toBeUndefined();
    expect(parseAllowedOrigins(" , ")).toBeUndefined();
  });

  it("splits a comma-separated list and trims it", () => {
    expect(parseAllowedOrigins("https://app.example, http://localhost:5173")).toEqual([
      "https://app.example",
      "http://localhost:5173",
    ]);
  });

  it("rejects anything that is not a bare origin", () => {
    expect(() => parseAllowedOrigins("https://app.example/")).toThrow('Invalid origin "https://app.example/"');
    expect(() => parseAllowedOrigins("app.example")).toThrow('Invalid origin "app.example"');
  });
});
