import { afterEach, expect, it, vi } from "vitest";

import { visualCookie } from "../../../config/visual-cookie";
import { DEFAULT_VISUAL_PREFERENCES } from "../types";
import { readVisualCookie, writeVisualCookie } from "./cookie";
import { readVisualRequestSeed } from "./cookie.server";
afterEach(() => {
  visualCookie.enabled = false;
  vi.restoreAllMocks();
  document.cookie = `${visualCookie.name}=; Max-Age=0; Path=/`;
});
it("reads only its named validated versioned cookie", () => {
  expect(readVisualCookie("other=value").kind).toBe("missing");
  expect(readVisualCookie(`${visualCookie.name}=%bad`).kind).toBe("invalid");
  const cookie = `${visualCookie.name}=${encodeURIComponent(JSON.stringify({ version: 1, preferences: { direction: "rtl", colorScheme: "bad" } }))}`;
  expect(readVisualCookie(cookie)).toMatchObject({ preferences: { direction: "rtl", colorScheme: "auto" } });
  const request = new Request("https://example.test", { headers: { cookie } });
  expect(readVisualRequestSeed(request)).toBeUndefined();
  visualCookie.enabled = true;
  expect(readVisualRequestSeed(request)?.direction).toBe("rtl");
});
it("checks writes, resets future versions explicitly and preserves unrelated cookies", () => {
  document.cookie = "unrelated=keep; Path=/";
  expect(writeVisualCookie({ ...DEFAULT_VISUAL_PREFERENCES, colorScheme: "dark" })).toBe("synced");
  expect(readVisualCookie(document.cookie)).toMatchObject({ preferences: { colorScheme: "dark" } });
  document.cookie = `${visualCookie.name}=${encodeURIComponent('{"version":2}')}; Path=/`;
  expect(writeVisualCookie(DEFAULT_VISUAL_PREFERENCES)).toBe("unsupported-version");
  expect(writeVisualCookie(DEFAULT_VISUAL_PREFERENCES, document, true)).toBe("synced");
  expect(document.cookie).toContain("unrelated=keep");
});
it("reports cookie rejection independently of browser preference state", () => {
  const doc = {
    get cookie() {
      return "";
    },
    set cookie(_value: string) {},
    location: document.location,
  };
  expect(writeVisualCookie(DEFAULT_VISUAL_PREFERENCES, doc)).toBe("failed");
});
