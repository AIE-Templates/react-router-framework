import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

import { createCookieJar, type CookieStore, STORE_TIMEOUT_MS } from "@repo/electron-cookies/main";
import { OMIT_COOKIES_HEADER } from "@repo/electron-cookies/shared";
import type { DesktopRequest } from "@repo/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { APP_HOST, APP_SCHEME, APP_ORIGIN, COOKIE_JAR_ORIGIN, isAppUrl } from "./app-url.ts";
import { createBootProfile } from "./boot-profile.ts";
import { fakeCookieStore } from "./cookie-store-testing.ts";
import { createDevProxyFetch } from "./dev-proxy.ts";
import type { Logger } from "./log.ts";
import { INTERNAL_ORIGIN } from "./mapping.ts";
import { type ProtocolSession, registerAppProtocol, REQUEST_HEADERS_TIMEOUT_MS } from "./protocol.ts";

// Load the production module with only its storage identity changed. All consumers use its real predicate.
vi.mock("./app-url.ts", async () => {
  const original = readFileSync(new URL("./app-url.ts", import.meta.url), "utf8");
  const source = original
    .replace('APP_SCHEME = "app"', 'APP_SCHEME = "xxx-app"')
    .replace('APP_HOST = "app"', 'APP_HOST = "site"');
  return import(
    /* @vite-ignore */ "data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(source)).toString("base64")
  );
});

it("DC-23: the production predicate follows a changed application scheme and host", () => {
  expect(APP_ORIGIN).toBe("xxx-app://site");
  expect(isAppUrl("xxx-app://site/area/")).toBe(true);
  for (const url of ["app://app/", "app://site/", "xxx-app://app/", "xxx-app://site:123/", "invalid"]) {
    expect(isAppUrl(url)).toBe(false);
  }
});

type Handler = (request: Request) => Promise<Response>;

const desktop = (): DesktopRequest => ({
  titlebar: "native",
  chromeMode: "system-decorated",
  fullscreen: false,
  prefs: {},
});

const log: Logger = {
  debug: vi.fn<Logger["debug"]>(),
  info: vi.fn<Logger["info"]>(),
  warn: vi.fn<Logger["warn"]>(),
  error: vi.fn<Logger["error"]>(),
};

/** Registers the `app://` handler on a fake session and returns it, with the jar's fake store. */
function setup(
  upstream: (request: Request) => Promise<Response>,
  {
    internalOrigin = INTERNAL_ORIGIN,
    store = fakeCookieStore(),
  }: { internalOrigin?: string; store?: CookieStore } = {},
) {
  let handler: Handler | undefined;
  const before = vi.fn<ProtocolSession["webRequest"]["onBeforeSendHeaders"]>();
  const onError = vi.fn<ProtocolSession["webRequest"]["onErrorOccurred"]>();
  const onCompleted = vi.fn<ProtocolSession["webRequest"]["onCompleted"]>();
  const session: ProtocolSession = {
    webRequest: { onBeforeSendHeaders: before, onErrorOccurred: onError, onCompleted },
    protocol: {
      handle: (scheme, h) => {
        expect(scheme).toBe(APP_SCHEME);
        handler = h;
      },
    },
  };
  registerAppProtocol(session, {
    upstream,
    internalOrigin,
    desktop,
    cookies: createCookieJar({
      store,
      host: APP_HOST,
      origin: APP_ORIGIN,
      storageOrigin: COOKIE_JAR_ORIGIN,
      upstreamHost: new URL(internalOrigin).hostname,
      fromPartition: () => ({ cookies: fakeCookieStore() }),
      installPermissionPolicy: vi.fn<() => void>(),
      log,
    }),
    log,
    profile: createBootProfile(false),
  });
  return {
    handle: (url: string, init?: RequestInit, initiatorOrigin?: string) =>
      handler!(Object.assign(new Request(url, init), { initiatorOrigin })),
    networkHeaders: (id: number, requestHeaders: Record<string, string> = {}, resourceType?: string) => {
      let headers!: Record<string, string>;
      before.mock.calls[0][1]({ id, requestHeaders, resourceType }, (response) => {
        headers = response.requestHeaders;
      });
      return headers;
    },
    disconnect: (id: number) => onError.mock.calls[0][0]({ id }),
    complete: (id: number) => onCompleted.mock.calls[0][0]({ id }),
  };
}

function withCookies(init: ResponseInit & { setCookie: string[] }): Response {
  const headers = new Headers(init.headers);
  for (const value of init.setCookie) headers.append("set-cookie", value);
  return new Response("ok", { status: init.status, headers });
}

describe("registerAppProtocol with the cookie jar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("forwards cancellation to a pending upstream request", async () => {
    let received: AbortSignal | undefined;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancelBody = vi.fn<() => void>();
    const { handle } = setup(async (request) => {
      received = request.signal;
      await blocked;
      return new Response(new ReadableStream({ cancel: cancelBody }));
    });
    const controller = new AbortController();
    const pending = handle(`${APP_ORIGIN}/`, { signal: controller.signal });
    await vi.waitFor(() => expect(received).toBeDefined());
    controller.abort();
    release();
    expect(received?.aborted).toBe(true);
    expect((await pending).type).toBe("error");
    expect(cancelBody).toHaveBeenCalledOnce();
  });

  it("injects the jar's Cookie before the upstream call and drops the page's own", async () => {
    const seen: (string | null)[] = [];
    const { handle } = setup(async (request) => {
      seen.push(request.headers.get("cookie"));
      return request.url.endsWith("/login")
        ? withCookies({ status: 200, setCookie: ["sid=1; Path=/; HttpOnly"] })
        : new Response("ok");
    });
    await handle(`${APP_ORIGIN}/login`, { method: "POST", body: "x" });
    await handle(`${APP_ORIGIN}/next`, { headers: { cookie: "forged=1" } });
    expect(seen).toEqual([null, "sid=1"]);
  });

  it("uses Electron's initiator when forwarding a POST with no Origin", async () => {
    const upstream = vi.fn<Handler>(async () => new Response());
    const { handle } = setup(upstream);
    for (const initiator of ["null", "https://site", APP_ORIGIN, undefined]) {
      await handle(APP_ORIGIN + "/submit", { method: "POST" }, initiator);
    }
    expect(upstream.mock.calls.map(([{ headers }]) => [headers.get("origin"), headers.get("sec-fetch-site")])).toEqual([
      [null, null],
      [null, null],
      [INTERNAL_ORIGIN, "same-origin"],
      [INTERNAL_ORIGIN, "same-origin"],
    ]);
  });

  it.each([
    [undefined, false, true],
    [APP_ORIGIN, false, true],
    [undefined, true, false],
    [APP_ORIGIN, true, false],
    ["null", false, false],
    ["media://site", false, false],
    ["https://site", false, false],
  ] as const)("applies initiator %s and omit %s on both hops", async (initiator, omit, allowed) => {
    const seen: (string | null)[] = [];
    const { handle } = setup(async (request) => {
      seen.push(request.headers.get("cookie"));
      expect(request.headers.has(OMIT_COOKIES_HEADER)).toBe(false);
      return withCookies({ setCookie: [request.url.endsWith("/seed") ? "sid=old" : "sid=new"] });
    });
    await handle(`${APP_ORIGIN}/seed`);
    const headers = new Headers({ cookie: "sid=forged" });
    if (omit) headers.set(OMIT_COOKIES_HEADER, "1");
    const response = await handle(`${APP_ORIGIN}/update`, { headers }, initiator);
    expect(response.headers.getSetCookie()).toEqual([]);
    await handle(`${APP_ORIGIN}/read`);
    expect(seen).toEqual([null, allowed ? "sid=old" : null, allowed ? "sid=new" : "sid=old"]);
  });

  it("skips the upstream call if the request was cancelled during a cookie lookup", async () => {
    const store = fakeCookieStore();
    let finishLookup!: () => void;
    store.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLookup = () => resolve([]);
        }),
    );
    const upstream = vi.fn<Handler>(async () => new Response("ok"));
    const { handle, networkHeaders, disconnect } = setup(upstream, { store });
    const pending = handle(`${APP_ORIGIN}/slow`, { headers: networkHeaders(7) });
    expect(store.get).toHaveBeenCalledOnce();
    disconnect(7);
    finishLookup();
    expect((await pending).type).toBe("error");
    expect(upstream).not.toHaveBeenCalled();
    expect(await (await handle(`${APP_ORIGIN}/next`)).text()).toBe("ok");
  });

  it("answers 503 without calling upstream when the cookie lookup never answers, and serves the next request", async () => {
    vi.useFakeTimers();
    const store = fakeCookieStore();
    store.get.mockImplementationOnce(() => new Promise(() => {}));
    const upstream = vi.fn<Handler>(async () => new Response("ok"));
    const { handle } = setup(upstream, { store });
    const pending = handle(`${APP_ORIGIN}/api/me`);
    await vi.advanceTimersByTimeAsync(STORE_TIMEOUT_MS);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(upstream).not.toHaveBeenCalled();
    expect(await (await handle(`${APP_ORIGIN}/api/me`)).text()).toBe("ok");
  });

  it("fails a main document whose cookie lookup never answers as a transport error, for the window's recovery", async () => {
    vi.useFakeTimers();
    const store = fakeCookieStore();
    store.get.mockImplementationOnce(() => new Promise(() => {}));
    const upstream = vi.fn<Handler>(async () => new Response("ok"));
    const { handle, networkHeaders } = setup(upstream, { store });
    const pending = handle(`${APP_ORIGIN}/`, { headers: networkHeaders(11, {}, "mainFrame") });
    await vi.advanceTimersByTimeAsync(STORE_TIMEOUT_MS);
    expect((await pending).type).toBe("error");
    expect(upstream).not.toHaveBeenCalled();
    expect(await (await handle(`${APP_ORIGIN}/`, { headers: networkHeaders(12, {}, "mainFrame") })).text()).toBe("ok");
  });

  it("delivers the response when storing its cookies never answers, and stores the next one's", async () => {
    vi.useFakeTimers();
    const store = fakeCookieStore();
    store.set.mockImplementationOnce(() => new Promise(() => {}));
    const { handle } = setup(async () => withCookies({ status: 200, setCookie: ["sid=1; Path=/"] }), { store });
    const pending = handle(`${APP_ORIGIN}/login`, { method: "POST", body: "x" });
    await vi.advanceTimersByTimeAsync(STORE_TIMEOUT_MS);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(store.cookies).toEqual([]);
    await handle(`${APP_ORIGIN}/login`, { method: "POST", body: "x" });
    expect(store.cookies.map((c) => c.name)).toEqual(["sid"]);
  });

  it("drops a request disconnected before dispatch and keeps the network ID out of the next upstream request", async () => {
    const upstream = vi.fn<Handler>(async () => new Response("ok"));
    const { handle, networkHeaders, disconnect } = setup(upstream);
    const headers = networkHeaders(8);
    disconnect(8);
    expect((await handle(`${APP_ORIGIN}/path`, { headers })).type).toBe("error");
    expect(upstream).not.toHaveBeenCalled();
    const next = networkHeaders(9, { "X-Desktop-Protocol-Request": headers["x-desktop-protocol-request"] });
    expect(await (await handle(`${APP_ORIGIN}/path`, { headers: next })).text()).toBe("ok");
    expect(upstream.mock.calls[0][0].headers.has("x-desktop-protocol-request")).toBe(false);
  });

  it("returns the response only after the store writes and the flush, without Set-Cookie", async () => {
    const store = fakeCookieStore();
    let release!: () => void;
    store.flushStore.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    const { handle } = setup(async () => withCookies({ status: 200, setCookie: ["keep=1; Path=/; Max-Age=60"] }), {
      store,
    });
    let returned: Response | undefined;
    const pending = handle(`${APP_ORIGIN}/`).then((response) => (returned = response));
    await vi.waitFor(() => expect(store.flushStore).toHaveBeenCalled());
    expect(store.cookies.map((c) => c.name)).toEqual(["keep"]);
    expect(returned).toBeUndefined();
    release();
    await pending;
    expect(returned?.status).toBe(200);
    expect(returned?.headers.getSetCookie()).toEqual([]);
  });

  it("releases only the completed network request when it never reaches the handler", async () => {
    const upstream = vi.fn<Handler>(async () => new Response("ok"));
    const { handle, networkHeaders, complete } = setup(upstream);
    const finished = networkHeaders(1);
    const active = networkHeaders(2);
    complete(1);
    expect((await handle(`${APP_ORIGIN}/path`, { headers: finished })).type).toBe("error");
    expect(upstream).not.toHaveBeenCalled();
    expect(await (await handle(`${APP_ORIGIN}/path`, { headers: active })).text()).toBe("ok");
  });

  it("cancels the response body if the renderer disconnects during the cookie flush", async () => {
    const store = fakeCookieStore();
    let finishFlush!: () => void;
    store.flushStore.mockImplementationOnce(() => new Promise<void>((resolve) => (finishFlush = resolve)));
    const cancel = vi.fn<() => void>();
    const { handle, networkHeaders, disconnect } = setup(
      async () => new Response(new ReadableStream({ cancel }), { headers: { "set-cookie": "sid=1; Path=/" } }),
      { store },
    );
    const pending = handle(`${APP_ORIGIN}/login`, { headers: networkHeaders(1) });
    await vi.waitFor(() => expect(store.flushStore).toHaveBeenCalledOnce());
    disconnect(1);
    finishFlush();
    expect((await pending).type).toBe("error");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("stores a redirect's Set-Cookie, so the redirected request carries it", async () => {
    const seen: (string | null)[] = [];
    const { handle } = setup(async (request) => {
      seen.push(request.headers.get("cookie"));
      return request.url.endsWith("/login")
        ? withCookies({
            status: 302,
            headers: { location: `${INTERNAL_ORIGIN}/home` },
            setCookie: ["sid=1; Path=/; HttpOnly"],
          })
        : new Response("home");
    });
    const redirect = await handle(`${APP_ORIGIN}/login`, { method: "POST", body: "x" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(`${APP_ORIGIN}/home`);
    await handle(redirect.headers.get("location")!);
    expect(seen).toEqual([null, "sid=1"]);
  });

  it("stores Set-Cookie from a React Router .data response (single fetch)", async () => {
    const seen: (string | null)[] = [];
    const { handle } = setup(async (request) => {
      seen.push(request.headers.get("cookie"));
      return new URL(request.url).pathname === "/account/login.data"
        ? withCookies({ status: 202, headers: { "content-type": "text/x-script" }, setCookie: ["sid=1; Path=/"] })
        : new Response("data", { headers: { "content-type": "text/x-script" } });
    });
    await handle(`${APP_ORIGIN}/account/login.data`, { method: "POST", body: "x" });
    await handle(`${APP_ORIGIN}/_root.data?_routes=root`);
    expect(seen).toEqual([null, "sid=1"]);
  });

  it("works on the development path: the dev-server proxy carries and receives cookies", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const cookie = new Headers(init?.headers).get("cookie");
      return cookie === null
        ? withCookies({ status: 200, setCookie: ["sid=dev; Path=/; Domain=localhost; HttpOnly"] })
        : new Response(cookie);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { handle } = setup(createDevProxyFetch(), { internalOrigin: "http://localhost:5174" });
    await handle(`${APP_ORIGIN}/login`, { method: "POST", body: "x" });
    const next = await handle(`${APP_ORIGIN}/next`);
    expect(await next.text()).toBe("sid=dev");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://localhost:5174/next");
  });

  it("aborts a dev fetch still waiting for headers, returns 504 and serves the next request", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("recovered"));
    fetchMock.mockImplementationOnce((_url, init) => {
      const signal = init!.signal!;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { handle } = setup(createDevProxyFetch());
    const pending = handle(`${APP_ORIGIN}/slow`);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const signal = fetchMock.mock.calls[0][1]!.signal!;
    await vi.advanceTimersByTimeAsync(REQUEST_HEADERS_TIMEOUT_MS);
    expect(signal.aborted).toBe(true);
    expect((await pending).status).toBe(504);
    expect(await (await handle(`${APP_ORIGIN}/next`)).text()).toBe("recovered");
  });

  it.each(["POST", "PATCH", "DELETE"])("never replays a bodyless %s after a connection reset", async (method) => {
    const reset = new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(reset).mockResolvedValue(new Response("next"));
    vi.stubGlobal("fetch", fetchMock);
    const { handle } = setup(createDevProxyFetch());
    expect((await handle(`${APP_ORIGIN}/write`, { method })).status).toBe(500);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await (await handle(`${APP_ORIGIN}/next`)).text()).toBe("next");
  });

  it.each(["GET", "HEAD"])("retries a %s after the dev server restarts", async (method) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { handle } = setup(createDevProxyFetch());
    expect((await handle(`${APP_ORIGIN}/read`, { method })).status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cancels a dev GET during retry backoff without sending a second attempt", async () => {
    let failAttempt!: (reason: Error) => void;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => (failAttempt = reject)))
      .mockResolvedValue(new Response("recovered"));
    vi.stubGlobal("fetch", fetchMock);
    const { handle, networkHeaders, disconnect } = setup(createDevProxyFetch());
    const pending = handle(`${APP_ORIGIN}/read`, { headers: networkHeaders(1) });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    failAttempt(new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }));
    // The fetch rejection enters backoff in the next microtask. Cancel before any retry timer can run.
    await Promise.resolve();
    disconnect(1);
    expect((await pending).type).toBe("error");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await (await handle(`${APP_ORIGIN}/read`, { headers: networkHeaders(2) })).text()).toBe("recovered");
  });

  it("keeps a dev response body live past the headers deadline and forwards later caller cancellation", async () => {
    vi.useFakeTimers();
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream.readable));
    vi.stubGlobal("fetch", fetchMock);
    const caller = new AbortController();
    const { handle } = setup(createDevProxyFetch());
    const response = await handle(`${APP_ORIGIN}/events`, { signal: caller.signal });
    const signal = fetchMock.mock.calls[0][1]!.signal!;
    await vi.advanceTimersByTimeAsync(REQUEST_HEADERS_TIMEOUT_MS + 1);
    expect(signal.aborted).toBe(false);
    const reader = response.body!.getReader();
    const chunk = Uint8Array.of(42);
    const read = reader.read();
    await stream.writable.getWriter().write(chunk);
    expect(await read).toEqual({ done: false, value: chunk });
    caller.abort();
    expect(signal.aborted).toBe(true);
    await reader.cancel();
  });
});
