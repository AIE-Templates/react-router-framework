import { createServerApp, logger } from "@repo/server";
import { describe, expect, it } from "vitest";

import { E2E_PREFIX, e2eRoutes, MAX_E2E_COOKIE_AGE_S, parseCookies } from "./e2e-routes.ts";

const origin = "http://app.desktop";

function createApp() {
  // Mounted the way the utility mounts it: inside the server's chain (request IDs, logging).
  const app = createServerApp({ logger: logger.child({}, { level: "silent" }) });
  app.route(E2E_PREFIX, e2eRoutes());
  return app;
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}/__e2e/cookies`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...headers },
    body: JSON.stringify(body),
  });
}

describe("e2eRoutes", () => {
  it("sets a persistent cookie with Max-Age and a session cookie without", async () => {
    const app = createApp();
    const persistent = await app.fetch(post({ name: "e2e-header-persistent", value: "p1", maxAge: 3600 }));
    expect(persistent.status).toBe(200);
    expect(persistent.headers.get("x-request-id")).toBeTruthy();
    expect(persistent.headers.get("set-cookie")).toBe(
      "e2e-header-persistent=p1; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600",
    );
    const session = await app.fetch(post({ name: "e2e-header-session", value: "s1" }));
    expect(session.headers.get("set-cookie")).toBe("e2e-header-session=s1; Path=/; HttpOnly; SameSite=Lax");
  });

  it("scopes a cookie to a path under the endpoints and deletes with Max-Age=0", async () => {
    const app = createApp();
    const scoped = await app.fetch(post({ name: "e2e-scoped", value: "s", path: "/__e2e/cookies/scoped" }));
    expect(scoped.headers.get("set-cookie")).toBe("e2e-scoped=s; Path=/__e2e/cookies/scoped; HttpOnly; SameSite=Lax");
    const removed = await app.fetch(post({ name: "e2e-a", value: "x", maxAge: 60, delete: true }));
    expect(removed.headers.get("set-cookie")).toBe("e2e-a=x; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    const plain = await app.fetch(post({ name: "e2e-plain", value: "p", httpOnly: false }));
    expect(plain.headers.get("set-cookie")).toBe("e2e-plain=p; Path=/; SameSite=Lax");
    const echo = await app.fetch(
      new Request(`${origin}/__e2e/cookies/scoped`, { headers: { cookie: "e2e-scoped=s" } }),
    );
    expect(await echo.json()).toEqual({ cookies: { "e2e-scoped": "s" } });
  });

  it("rejects names outside e2e-*, odd values and unbounded lifetimes", async () => {
    const app = createApp();
    for (const body of [
      { name: "session", value: "x" },
      { name: "e2e-a", value: "x; Domain=evil" },
      { name: "e2e-a", value: "x", maxAge: MAX_E2E_COOKIE_AGE_S + 1 },
      { name: "e2e-a", value: "x", maxAge: 0 },
      { name: "e2e-a", value: "x", path: "/elsewhere" },
      { name: "e2e-a", value: "x", path: "/__e2e/x; Domain=evil" },
      { name: "e2e-a", value: "x", delete: "yes" },
      { name: "e2e-a", value: "x", httpOnly: "no" },
      null,
    ]) {
      const response = await app.fetch(post(body));
      expect(response.status).toBe(400);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("reports the e2e-* cookies the request carried", async () => {
    const app = createApp();
    const response = await app.fetch(
      new Request(`${origin}/__e2e/cookies`, { headers: { cookie: "e2e-a=1; other=2; e2e-b=two" } }),
    );
    expect(await response.json()).toEqual({ cookies: { "e2e-a": "1", "e2e-b": "two" } });
  });

  it("parses an absent or malformed Cookie header to nothing", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("garbage; =x; e2e-")).toEqual({});
  });
});
