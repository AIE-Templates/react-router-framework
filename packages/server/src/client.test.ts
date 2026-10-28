// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { createServerApp } from "./app.ts";
import { createApiClient } from "./client.ts";
import { createInProcessFetch } from "./in-process.ts";

const app = createServerApp();

afterEach(() => {
  vi.restoreAllMocks();
});

// The Request the in-process client passed to app.request().
function sentRequest(spy: { mock: { calls: unknown[][] } }): Request {
  const [request] = spy.mock.calls[0] ?? [];
  if (!(request instanceof Request)) throw new Error("expected app.request() to receive a Request");
  return request;
}

describe("createApiClient", () => {
  it("calls the app in-process with createInProcessFetch()", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = createApiClient(new Request("https://example.com/some/page"), {
      fetch: createInProcessFetch(app),
    });

    const response = await client.api.health.$get();

    expect(await response.json()).toEqual({ status: "ok" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls a server running elsewhere with the global fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ status: "ok" }));
    const client = createApiClient(new Request("https://example.com/some/page"), {
      origin: "http://server:3000",
    });

    await client.api.health.$get();

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(new Request(...fetchSpy.mock.calls[0]).url).toBe("http://server:3000/api/health");
  });

  it("forwards only the caller's credentials", async () => {
    const requestSpy = vi.spyOn(app, "request");
    const client = createApiClient(
      new Request("https://example.com/", {
        headers: {
          cookie: "session=abc",
          authorization: "Bearer token",
          origin: "https://example.com",
          "sec-fetch-site": "same-origin",
          "x-other": "ignored",
        },
      }),
      { fetch: createInProcessFetch(app) },
    );

    await client.api.health.$get();

    const { headers } = sentRequest(requestSpy);
    expect(headers.get("cookie")).toBe("session=abc");
    expect(headers.get("authorization")).toBe("Bearer token");
    expect(headers.has("origin")).toBe(false);
    expect(headers.has("sec-fetch-site")).toBe(false);
    expect(headers.has("x-other")).toBe(false);
  });

  it("sends the caller's request ID, so the call logs under it", async () => {
    const requestSpy = vi.spyOn(app, "request");
    const client = createApiClient(new Request("https://example.com/"), {
      fetch: createInProcessFetch(app),
      requestId: "req-1",
    });

    const response = await client.api.health.$get();

    expect(sentRequest(requestSpy).headers.get("x-request-id")).toBe("req-1");
    expect(response.headers.get("x-request-id")).toBe("req-1");
  });

  it("aborts calls when the caller's request is aborted", async () => {
    const requestSpy = vi.spyOn(app, "request");
    const controller = new AbortController();
    const client = createApiClient(new Request("https://example.com/", { signal: controller.signal }), {
      fetch: createInProcessFetch(app),
    });

    await client.api.health.$get();
    const { signal } = sentRequest(requestSpy);

    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });
});

describe("createInProcessFetch", () => {
  it("skips the API's CSRF check, whatever page request it acts for", async () => {
    // A typed-in URL or a link from another site: no Origin, Sec-Fetch-Site none or cross-site.
    for (const site of [undefined, "none", "cross-site"]) {
      const response = await createInProcessFetch(app)("https://example.com/api/health", {
        method: "POST",
        headers: { "content-type": "text/plain", ...(site ? { "sec-fetch-site": site } : {}) },
        body: "{}",
      });

      // Past the CSRF check; this route has no POST, hence the JSON 404.
      expect(response.status).toBe(404);
    }
  });
});
