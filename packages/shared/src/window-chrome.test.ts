import { describe, expect, it } from "vitest";

import {
  DESKTOP_BOOTSTRAP_ARGUMENT,
  desktopBootstrapFromArguments,
  parseDesktopBootstrap,
  parseOverlayAppearance,
} from "./window-chrome.ts";

const bootstrap = {
  protocolVersion: 1,
  shell: { kind: "desktop", platform: "darwin", osVersion: "26" },
  mode: "native-overlay",
};

describe("desktop bootstrap", () => {
  it("reads a frozen, bounded static protocol without window facts", () => {
    const parsed = desktopBootstrapFromArguments([`${DESKTOP_BOOTSTRAP_ARGUMENT}${JSON.stringify(bootstrap)}`]);
    expect(parsed).toEqual(bootstrap);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.shell)).toBe(true);
    expect(parseDesktopBootstrap({ ...bootstrap, focused: true })).toBeNull();
  });
  it("rejects incompatible, malformed, unsupported or excessive payloads", () => {
    for (const value of [
      null,
      [],
      { ...bootstrap, protocolVersion: 2 },
      { ...bootstrap, mode: "custom-controls" },
      { ...bootstrap, shell: { ...bootstrap.shell, platform: "other" } },
    ])
      expect(parseDesktopBootstrap(value)).toBeNull();
    expect(desktopBootstrapFromArguments([`${DESKTOP_BOOTSTRAP_ARGUMENT}{`])).toBeNull();
    expect(desktopBootstrapFromArguments([`${DESKTOP_BOOTSTRAP_ARGUMENT}${" ".repeat(2049)}`])).toBeNull();
  });
});

describe("overlay appearance", () => {
  it("accepts bounded partial updates", () => {
    expect(parseOverlayAppearance({ height: 36, color: "#112233", symbolColor: "#ffeeddff" })).toEqual({
      height: 36,
      color: "#112233",
      symbolColor: "#ffeeddff",
    });
  });
  it("rejects unknown fields, arbitrary colors and unsafe heights", () => {
    for (const value of [
      {},
      { color: "red" },
      { color: "#fff" },
      { height: 0 },
      { height: 81 },
      { height: 32.5 },
      { height: Infinity },
      { height: 36, windowId: 1 },
    ])
      expect(parseOverlayAppearance(value)).toBeNull();
  });
});
