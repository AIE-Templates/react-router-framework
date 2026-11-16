import { describe, expect, it } from "vitest";

import { APP_HOST, APP_ORIGIN, APP_SCHEME, isAppUrl } from "./app-url.ts";

describe("application origin", () => {
  it("preserves the existing browser storage identity", () => {
    expect({ APP_SCHEME, APP_HOST, APP_ORIGIN }).toEqual({
      APP_SCHEME: "app",
      APP_HOST: "app",
      APP_ORIGIN: "app://app",
    });
    expect(isAppUrl(`${APP_ORIGIN}/chat/1?view=details#message`)).toBe(true);
    expect(isAppUrl(APP_ORIGIN)).toBe(true);
  });

  it.each(["app://evil/", "app://app.evil/", "app://app:123/", "https://app/", "file:///app", "invalid"])(
    "rejects other origins: %s",
    (url) => expect(isAppUrl(url)).toBe(false),
  );
});
