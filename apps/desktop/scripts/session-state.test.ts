import { describe, expect, it } from "vitest";

import { screenLock } from "./session-state.ts";

function fail(): never {
  throw new Error("ioreg failed");
}

describe("screen lock", () => {
  it.each([true, false])("uses the foreground session (locked: %s)", (locked) => {
    const front = { kCGSSessionOnConsoleKey: true, CGSSessionScreenIsLocked: locked };
    const back = { kCGSSessionOnConsoleKey: false, CGSSessionScreenIsLocked: !locked };
    for (const sessions of [
      [front, back],
      [back, front],
    ]) {
      expect(screenLock("darwin", () => sessions)).toEqual({ locked });
    }
  });

  it("handles an absent lock flag, missing console session and unreadable listing", () => {
    expect(screenLock("darwin", () => [{ kCGSSessionOnConsoleKey: true }])).toEqual({ locked: false });
    expect(screenLock("darwin", () => [])).toHaveProperty("unknown");
    expect(screenLock("darwin", fail)).toHaveProperty("unknown");
    expect(screenLock("linux", fail)).toEqual({ locked: false });
    expect(screenLock("win32", fail)).toEqual({ locked: false });
  });

  it.runIf(process.platform === "darwin")("reads this Mac's real listing", () => {
    expect(screenLock()).toHaveProperty("locked");
  });
});
