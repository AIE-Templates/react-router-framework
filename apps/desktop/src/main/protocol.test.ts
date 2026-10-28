import type { DesktopRequest } from "@repo/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBootProfile } from "./boot-profile.ts";
import { createCookieJar, type CookieStore } from "./cookie-jar.ts";
import { fakeCookieStore } from "./cookie-store-testing.ts";
import { createDevProxyFetch } from "./dev-proxy.ts";
import type { Logger } from "./log.ts";
import { INTERNAL_ORIGIN } from "./mapping.ts";
import { type ProtocolSession, registerAppProtocol } from "./protocol.ts";

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
  const session: ProtocolSession = {
    protocol: {
      handle: (_scheme, h) => {
        handler = h;
      },
    },
  };
  registerAppProtocol(session, {
    upstream,
    internalOrigin,
    desktop,
    cookies: createCookieJar({ store, hosts: ["app.desktop", new URL(internalOrigin).hostname], log }),
    log,
    profile: createBootProfile(false),
  });
  return { handle: (url: string, init?: RequestInit) => handler!(new Request(url, init)) };
}

function withCookies(init: ResponseInit & { setCookie: string[] }): Response {
  const headers = new Headers(init.headers);
  for (const value of init.setCookie) headers.append("set-cookie", value);
  return new Response("ok", { status: init.status, headers });
}

describe("registerAppProtocol with the cookie jar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("injects the jar's Cookie before the upstream call and drops the page's own", async () => {
    const seen: (string | null)[] = [];
    const { handle } = setup(async (request) => {
      seen.push(request.headers.get("cookie"));
      return request.url.endsWith("/login")
        ? withCookies({ status: 200, setCookie: ["sid=1; Path=/; HttpOnly"] })
        : new Response("ok");
    });
    await handle("app://app/login", { method: "POST", body: "x" });
    await handle("app://app/next", { headers: { cookie: "forged=1" } });
    expect(seen).toEqual([null, "sid=1"]);
  });

  it("returns the response only after the store writes and the flush, without Set-Cookie", async () => {
    const store = fakeCookieStore();
    let release!: () => void;
    store.flushStore.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    const { handle } = setup(async () => withCookies({ status: 200, setCookie: ["keep=1; Path=/; Max-Age=60"] }), {
      store,
    });
    let returned: Response | undefined;
    const pending = handle("app://app/").then((response) => (returned = response));
    await vi.waitFor(() => expect(store.flushStore).toHaveBeenCalled());
    expect(store.cookies.map((c) => c.name)).toEqual(["keep"]);
    expect(returned).toBeUndefined();
    release();
    await pending;
    expect(returned?.status).toBe(200);
    expect(returned?.headers.getSetCookie()).toEqual([]);
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
    const redirect = await handle("app://app/login", { method: "POST", body: "x" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("app://app/home");
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
    await handle("app://app/account/login.data", { method: "POST", body: "x" });
    await handle("app://app/_root.data?_routes=root");
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
    await handle("app://app/login", { method: "POST", body: "x" });
    const next = await handle("app://app/next");
    expect(await next.text()).toBe("sid=dev");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://localhost:5174/next");
  });
});
