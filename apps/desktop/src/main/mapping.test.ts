import { PortBusyError, PortClosedError, PortFetchTimeoutError, RemoteFetchError } from "@repo/port-fetch";
import { describe, expect, it } from "vitest";

import {
  APP_ORIGIN,
  failureStatus,
  INTERNAL_ORIGIN,
  shapeRequestHeaders,
  shapeResponseHeaders,
  toAppUrl,
  toInternalUrl,
} from "./mapping.ts";

const desktop = {
  titlebar: "native" as const,
  chromeMode: "system-decorated" as const,
  fullscreen: false,
  prefs: { theme: "dark" },
};

describe("URL mapping", () => {
  it("maps app://app to the internal origin and back", () => {
    expect(toInternalUrl("app://app/chat/42?x=1")).toBe(`${INTERNAL_ORIGIN}/chat/42?x=1`);
    expect(toInternalUrl("app://app/")).toBe(`${INTERNAL_ORIGIN}/`);
    expect(toAppUrl(`${INTERNAL_ORIGIN}/next?y=2`)).toBe(`${APP_ORIGIN}/next?y=2`);
    expect(toAppUrl(INTERNAL_ORIGIN)).toBe(APP_ORIGIN);
  });

  it("rejects other hosts and leaves foreign URLs alone", () => {
    expect(toInternalUrl("app://evil/")).toBeNull();
    expect(toInternalUrl("https://app/")).toBeNull();
    expect(toAppUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(toAppUrl("/relative")).toBe("/relative");
  });

  it("uses a custom internal origin in development", () => {
    expect(toInternalUrl("app://app/x", "http://localhost:5174")).toBe("http://localhost:5174/x");
    expect(toAppUrl("http://localhost:5174/x", "http://localhost:5174")).toBe("app://app/x");
  });
});

describe("shapeRequestHeaders", () => {
  it("rewrites Origin and Referer and injects the desktop headers", () => {
    const headers = shapeRequestHeaders(
      new Headers({ origin: APP_ORIGIN, referer: `${APP_ORIGIN}/page`, accept: "text/html", host: "app" }),
      { method: "POST", desktop },
    );

    expect(headers.get("origin")).toBe(INTERNAL_ORIGIN);
    expect(headers.get("referer")).toBe(`${INTERNAL_ORIGIN}/page`);
    expect(headers.get("accept")).toBe("text/html");
    expect(headers.has("host")).toBe(false);
    expect(headers.get("x-desktop-titlebar")).toBe("native");
    expect(headers.get("x-desktop-fullscreen")).toBe("0");
    expect(headers.get("x-desktop-prefs")).toBe('{"theme":"dark"}');
  });

  it("synthesizes Origin and Sec-Fetch-Site on non-GET requests without one, never on GET", () => {
    const post = shapeRequestHeaders(new Headers(), { method: "POST", desktop });
    expect(post.get("origin")).toBe(INTERNAL_ORIGIN);
    expect(post.get("sec-fetch-site")).toBe("same-origin");

    const get = shapeRequestHeaders(new Headers(), { method: "GET", desktop });
    expect(get.has("origin")).toBe(false);
    expect(get.has("sec-fetch-site")).toBe(false);
  });

  it("drops a Cookie header a page sent", () => {
    const headers = shapeRequestHeaders(new Headers({ cookie: "forged=1", accept: "*/*" }), { method: "GET", desktop });
    expect(headers.has("cookie")).toBe(false);
    expect(headers.get("accept")).toBe("*/*");
  });

  it("drops x-desktop-* headers a page sent", () => {
    const headers = shapeRequestHeaders(new Headers({ "x-desktop-titlebar": "custom", "x-desktop-evil": "1" }), {
      method: "GET",
      desktop: { ...desktop, fullscreen: true },
    });

    expect(headers.get("x-desktop-titlebar")).toBe("native");
    expect(headers.has("x-desktop-evil")).toBe(false);
    expect(headers.get("x-desktop-fullscreen")).toBe("1");
  });
});

describe("shapeResponseHeaders", () => {
  it("removes Set-Cookie and keeps everything else", () => {
    const headers = new Headers({ "content-type": "text/html" });
    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2");
    const out = shapeResponseHeaders(headers);
    expect(out.getSetCookie()).toEqual([]);
    expect(out.get("content-type")).toBe("text/html");
    expect(headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });

  it("maps an absolute Location on the internal origin back to app://", () => {
    expect(shapeResponseHeaders(new Headers({ location: `${INTERNAL_ORIGIN}/login` })).get("location")).toBe(
      `${APP_ORIGIN}/login`,
    );
    expect(shapeResponseHeaders(new Headers({ location: "/login" })).get("location")).toBe("/login");
    expect(shapeResponseHeaders(new Headers({ location: "https://example.com/" })).get("location")).toBe(
      "https://example.com/",
    );
  });
});

describe("asciiJson", () => {
  it("escapes non-ASCII characters so the value is a header ByteString, and round-trips", async () => {
    const { asciiJson } = await import("./mapping.ts");
    const { parseDesktopHeaders, DESKTOP_HEADERS } = await import("@repo/shared");
    const prefs = { theme: "\u4e2d\u6587\u4e3b\u9898", mood: "😀", control: "a\u0001b\n", n: 1, on: true };

    const value = asciiJson(prefs);
    expect(/^[\x20-\x7e]*$/.test(value)).toBe(true);
    const headers = new Headers({ [DESKTOP_HEADERS.prefs]: value });
    expect(parseDesktopHeaders(headers).prefs).toEqual(prefs);
  });
});

describe("failureStatus", () => {
  it.each([
    ["the port closing", new PortClosedError(), 503],
    ["the local request budget", new PortBusyError(256), 503],
    ["the local unread budget", new PortBusyError(256, "unread", 8), 503],
    ["the server's request budget", new RemoteFetchError("busy", { code: "busy" }), 503],
    ["a timeout", new PortFetchTimeoutError(1000, "headers"), 504],
    ["the app failing", new RemoteFetchError("boom", { code: "fetch-failed" }), 500],
    ["anything else", new Error("x"), 500],
  ])("maps %s to %i", (_name, err, status) => {
    expect(failureStatus(err).status).toBe(status);
  });
});
