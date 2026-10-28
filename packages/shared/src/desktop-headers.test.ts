import { describe, expect, it } from "vitest";

import { DESKTOP_HEADERS, isDesktopHeader, parseDesktopHeaders } from "./desktop-headers.ts";

describe("parseDesktopHeaders", () => {
  it("defaults without headers", () => {
    expect(parseDesktopHeaders(new Headers())).toEqual({
      titlebar: "native",
      chromeMode: "system-decorated",
      fullscreen: false,
      prefs: {},
    });
  });

  it("reads the headers", () => {
    const headers = new Headers({
      "X-Desktop-Titlebar": "custom",
      "X-Desktop-Chrome-Mode": "native-overlay",
      "X-Desktop-Fullscreen": "1",
      "X-Desktop-Prefs": JSON.stringify({ theme: "dark", sidebarWidth: 280, compact: true }),
    });

    expect(parseDesktopHeaders(headers)).toEqual({
      titlebar: "custom",
      chromeMode: "native-overlay",
      fullscreen: true,
      prefs: { theme: "dark", sidebarWidth: 280, compact: true },
    });
  });

  it("falls back to defaults for unknown values", () => {
    const headers = new Headers({
      [DESKTOP_HEADERS.titlebar]: "hidden",
      [DESKTOP_HEADERS.fullscreen]: "true",
    });

    expect(parseDesktopHeaders(headers)).toEqual({
      titlebar: "native",
      chromeMode: "system-decorated",
      fullscreen: false,
      prefs: {},
    });
  });

  it("ignores malformed preferences and drops values that are not primitives", () => {
    for (const prefs of ["{", "null", "[1,2]", '"dark"', "42"]) {
      expect(parseDesktopHeaders(new Headers({ [DESKTOP_HEADERS.prefs]: prefs })).prefs).toEqual({});
    }
    const mixed = JSON.stringify({ theme: "dark", nested: { a: 1 }, list: [1], empty: null, width: 240 });
    expect(parseDesktopHeaders(new Headers({ [DESKTOP_HEADERS.prefs]: mixed })).prefs).toEqual({
      theme: "dark",
      width: 240,
    });
    const proto = '{"__proto__":{"polluted":true},"theme":"light"}';
    const parsed = parseDesktopHeaders(new Headers({ [DESKTOP_HEADERS.prefs]: proto })).prefs;
    expect(parsed).toEqual({ theme: "light" });
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });
});

describe("isDesktopHeader", () => {
  it("matches the x-desktop- prefix case-insensitively", () => {
    expect(isDesktopHeader("X-Desktop-Titlebar")).toBe(true);
    expect(isDesktopHeader("x-desktop-anything")).toBe(true);
    expect(isDesktopHeader("x-desktopish")).toBe(false);
    expect(isDesktopHeader("x-request-id")).toBe(false);
  });
});
