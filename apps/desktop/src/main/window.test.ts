import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { createWindowKeeper, isAppUrl, safePath } from "./window.ts";

class FakeWindow extends EventEmitter {
  destroyed = false;
  isDestroyed(): boolean {
    return this.destroyed;
  }
  close(): void {
    this.destroyed = true;
    this.emit("closed");
  }
}

describe("createWindowKeeper", () => {
  it("reopens after every close, not only the first, and never holds a destroyed window", () => {
    const made: FakeWindow[] = [];
    const keeper = createWindowKeeper(() => {
      const win = new FakeWindow();
      made.push(win);
      return win;
    });

    for (let round = 1; round <= 3; round++) {
      const opened = keeper.open();
      expect(opened.created).toBe(true);
      expect(keeper.current()).toBe(opened.window);
      // A second open() while it lives returns the same window.
      expect(keeper.open()).toEqual({ window: opened.window, created: false });
      opened.window.close();
      expect(keeper.current()).toBeUndefined();
      expect(made).toHaveLength(round);
    }
  });

  it("keeps a newer window when an older one's closed event arrives late", () => {
    const keeper = createWindowKeeper(() => new FakeWindow());
    const first = keeper.open().window;
    first.destroyed = true; // destroyed without the event yet
    const second = keeper.open().window;
    expect(second).not.toBe(first);
    first.emit("closed");

    expect(keeper.current()).toBe(second);
  });
});

describe("url helpers", () => {
  it("accepts only app://app", () => {
    expect(isAppUrl("app://app/chat/1?x=1")).toBe(true);
    expect(isAppUrl("app://evil/")).toBe(false);
    expect(isAppUrl("https://app/")).toBe(false);
    expect(isAppUrl("not a url")).toBe(false);
  });

  it("logs paths without query strings", () => {
    expect(safePath("https://example.com/path?token=secret")).toBe("https://example.com/path");
    expect(safePath("nope")).toBe("(invalid URL)");
  });
});
