import { describe, expect, it } from "vitest";

import { chromeWindowOptions, resolveChromePolicy } from "./chrome-policy.ts";

describe("chrome policy", () => {
  it.each(["darwin", "win32", "linux"])("defaults %s to native overlay without a validation gate", (platform) => {
    const policy = resolveChromePolicy({ platform });
    expect(policy).toMatchObject({ requestedMode: "native-overlay", resolvedMode: "native-overlay" });
    expect(policy.fallbackReason).toBeUndefined();
    expect(chromeWindowOptions(policy)).toMatchObject({
      titleBarStyle: "hidden",
      titleBarOverlay: { height: platform === "linux" ? 36 : 48 },
    });
    expect(resolveChromePolicy({ platform, requestedMode: "system-decorated" }).resolvedMode).toBe("system-decorated");
  });
  it("retains fallbacks only for unsupported platforms and unimplemented custom controls", () => {
    expect(resolveChromePolicy({ platform: "other" })).toMatchObject({
      resolvedMode: "system-decorated",
      fallbackReason: "unsupported-platform",
    });
    expect(resolveChromePolicy({ platform: "darwin", requestedMode: "custom-controls" })).toMatchObject({
      resolvedMode: "system-decorated",
      fallbackReason: "custom-controls-not-implemented",
    });
  });
  it("centers native mac controls in the 48-unit header without assuming a button size or position", () => {
    const policy = resolveChromePolicy({ platform: "darwin", themePreference: "dark" });
    expect(chromeWindowOptions(policy)).toEqual({
      backgroundColor: "#17191d",
      titleBarStyle: "hidden",
      titleBarOverlay: { height: 48 },
    });
  });
  it("selects theme before construction and leaves decorated windows decorated", () => {
    expect(resolveChromePolicy({ platform: "win32", darkColors: true }).appearance.color).toBe("#17191d");
    expect(
      resolveChromePolicy({ platform: "win32", darkColors: true, themePreference: "light" }).appearance.color,
    ).toBe("#ffffff");
    expect(chromeWindowOptions(resolveChromePolicy({ platform: "darwin", requestedMode: "system-decorated" }))).toEqual(
      { backgroundColor: "#ffffff" },
    );
  });
});
