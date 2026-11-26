import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DESKTOP_CHROME_IPC } from "@repo/shared";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const theme = vi.hoisted(() => ({
  shouldUseDarkColors: false,
  on: vi.fn<(event: string, handler: () => void) => void>(),
  off: vi.fn<(event: string, handler: () => void) => void>(),
}));
vi.mock("electron", () => ({ nativeTheme: theme }));

import { resolveChromePolicy } from "./chrome-policy.ts";
import { installWindowChrome } from "./chrome.ts";
import { createVisualMirror } from "./visual-mirror.ts";

class FakeWindow extends EventEmitter {
  focused = false;
  maximized = false;
  fullscreen = false;
  handlers = new Map<string, (...args: unknown[]) => unknown>();
  ipc = {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => this.handlers.set(channel, handler),
    removeHandler: (channel: string) => this.handlers.delete(channel),
    on: vi.fn<(channel: string, handler: (...args: unknown[]) => void) => void>(),
    off: vi.fn<(channel: string, handler: (...args: unknown[]) => void) => void>(),
  };
  // Fixture callbacks accept structural doubles for native events.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  webContents = Object.assign(new EventEmitter(), { ipc: this.ipc as unknown as Electron.IpcMain });
  isDestroyed = () => false;
  isFocused = () => this.focused;
  isMaximized = () => this.maximized;
  isFullScreen = () => this.fullscreen;
  setBackgroundColor = vi.fn<(color: string) => void>();
  setTitleBarOverlay = vi.fn<(...args: unknown[]) => void>();
}
const log = {
  warn: vi.fn<(...args: unknown[]) => void>(),
  error: vi.fn<(...args: unknown[]) => void>(),
  info: vi.fn<(...args: unknown[]) => void>(),
  debug: vi.fn<(...args: unknown[]) => void>(),
};
const frame = () => ({ send: vi.fn<(...args: unknown[]) => void>(), detached: false });

const trusted = (input: IpcMainEvent | IpcMainInvokeEvent) => "allowed" in input && input.allowed === true;

const directories: string[] = [];
function themeFixture() {
  const directory = mkdtempSync(join(tmpdir(), "window-theme-"));
  directories.push(directory);
  return createVisualMirror(directory, { log });
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function setup(platform = "win32", store = themeFixture(), fixedAppearance?: "light" | "dark") {
  const win = new FakeWindow();
  const source = frame();
  const event = { senderFrame: source, allowed: true };
  const dispose = installWindowChrome(win, resolveChromePolicy({ platform }), trusted, log, store, fixedAppearance);
  const invoke = (channel: string, ...args: unknown[]) => win.handlers.get(channel)!(...args);
  const document = invoke(DESKTOP_CHROME_IPC.visualDocument, event);
  const declare = (revision: number, appearance: unknown, sender = event) =>
    invoke(DESKTOP_CHROME_IPC.declaration, sender, { document, declaration: { owner: "shell", revision, appearance } });
  return { win, event, source, dispose, store, invoke, document, declare };
}

beforeEach(() => {
  vi.clearAllMocks();
  theme.shouldUseDarkColors = false;
});

describe("window chrome bridge", () => {
  it("validates senders and sends actual initial facts followed by changed source revisions", () => {
    const { win, event, source, dispose, invoke } = setup();
    expect(invoke(DESKTOP_CHROME_IPC.subscribe, { ...event, allowed: false }, "a")).toBeNull();
    expect(invoke(DESKTOP_CHROME_IPC.subscribe, event, {})).toBeNull();
    win.focused = true;
    expect(invoke(DESKTOP_CHROME_IPC.subscribe, event, "a")).toEqual({
      token: "a",
      state: { revision: 1, focused: true, maximized: false, fullscreen: false },
    });
    win.emit("focus");
    expect(source.send).not.toHaveBeenCalled();
    win.maximized = true;
    win.emit("maximize");
    expect(source.send).toHaveBeenCalledWith(DESKTOP_CHROME_IPC.state, {
      token: "a",
      state: { revision: 2, focused: true, maximized: true, fullscreen: false },
    });
    dispose();
  });

  it("expires subscriptions on new main documents and renderer exit while retaining same-document navigation", () => {
    const { win, event, source, dispose, invoke } = setup();
    invoke(DESKTOP_CHROME_IPC.subscribe, event, "old");
    win.webContents.emit("did-start-navigation", {}, "app://app/#one", true, true);
    win.focused = true;
    win.emit("focus");
    expect(source.send).toHaveBeenCalledTimes(1);
    win.webContents.emit("did-navigate", {}, "app://app/");
    win.maximized = true;
    win.emit("maximize");
    expect(source.send).toHaveBeenCalledTimes(1);
    const fresh = frame();
    expect(invoke(DESKTOP_CHROME_IPC.subscribe, { ...event, senderFrame: fresh }, "new")).toMatchObject({
      token: "new",
      state: { focused: true, maximized: true },
    });
    const unsubscribe = win.ipc.on.mock.calls.find(([channel]) => channel === DESKTOP_CHROME_IPC.unsubscribe)![1];
    unsubscribe(event, "old");
    win.fullscreen = true;
    win.emit("enter-full-screen");
    expect(fresh.send).toHaveBeenCalledTimes(1);
    win.webContents.emit("render-process-gone");
    win.focused = false;
    win.emit("blur");
    expect(fresh.send).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("applies the current overlay on first navigation even when a child was created under an earlier theme", () => {
    const { win, dispose } = setup();
    win.webContents.emit("did-navigate", {}, "app://app/");
    expect(win.setTitleBarOverlay).toHaveBeenCalledOnce();
    win.webContents.emit("did-navigate", {}, "app://app/editor");
    expect(win.setTitleBarOverlay).toHaveBeenCalledOnce();
    dispose();
  });

  it("bounds appearance updates, avoids duplicate writes and clears all listeners on close", () => {
    const { win, event, declare } = setup();
    expect(declare(1, { height: 40 }, { ...event, allowed: false })).toEqual({
      status: "rejected",
      reason: "untrusted-sender",
    });
    expect(declare(1, { height: 400 })).toEqual({
      status: "rejected",
      reason: "invalid-appearance",
    });
    expect(declare(1, { height: 40 })).toMatchObject({
      status: "applied",
      appearance: { height: 40 },
    });
    declare(2, { height: 40 });
    expect(win.setTitleBarOverlay).toHaveBeenCalledTimes(1);
    win.emit("closed");
    expect(win.handlers.size).toBe(0);
    expect(win.listenerCount("focus")).toBe(0);
    expect(win.webContents.listenerCount("did-navigate")).toBe(0);
  });

  it("reports macOS runtime appearance updates unavailable without moving native controls", () => {
    const { win, dispose, declare } = setup("darwin");
    expect(declare(1, { height: 40 })).toMatchObject({ status: "unsupported" });
    expect(win.setTitleBarOverlay).not.toHaveBeenCalled();
    dispose();
  });
  it("follows system appearance until close without changing native macOS button geometry", () => {
    const { win } = setup("darwin");
    const updated = theme.on.mock.calls.find(([event]) => event === "updated")![1];
    theme.shouldUseDarkColors = true;
    updated();
    expect(win.setBackgroundColor).toHaveBeenCalledWith("#17191d");
    expect(win.setTitleBarOverlay).not.toHaveBeenCalled();
    win.emit("closed");
    expect(theme.off).toHaveBeenCalledWith("updated", updated);
  });
  it("keeps both windows' handlers independent when one closes", () => {
    const old = setup();
    const fresh = setup();
    expect(old.invoke(DESKTOP_CHROME_IPC.subscribe, old.event, "original")).toMatchObject({ token: "original" });
    old.win.emit("closed");
    expect(fresh.invoke(DESKTOP_CHROME_IPC.subscribe, fresh.event, "reopened")).toMatchObject({ token: "reopened" });
    fresh.win.focused = true;
    fresh.win.emit("focus");
    expect(fresh.source.send).toHaveBeenCalledTimes(1);
    expect(old.win.listenerCount("focus")).toBe(0);
    fresh.dispose();
  });
  it("keeps overrides separate from theme backgrounds and fills missing overlay fields from the theme", () => {
    const { win, dispose, declare } = setup();
    const updated = theme.on.mock.calls.find(([name]) => name === "updated")![1];
    declare(1, { height: 40 });
    theme.shouldUseDarkColors = true;
    updated();
    expect(win.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: "#17191d", symbolColor: "#f3f4f6", height: 40 });
    declare(2, { height: 40, color: "#224466" });
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith("#17191d");
    const writes = win.setTitleBarOverlay.mock.calls.length;
    theme.shouldUseDarkColors = false;
    updated();
    expect(win.setTitleBarOverlay).toHaveBeenCalledTimes(writes + 1);
    expect(win.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: "#224466", symbolColor: "#202124", height: 40 });
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith("#ffffff");
    dispose();
  });
  it.each(["did-navigate", "render-process-gone"])(
    "replaces and releases complete declarations, retiring the owner on %s",
    (retireEvent) => {
      const { win, event, dispose, invoke, document, store } = setup();
      const declare = (owner: string, revision: number, appearance: unknown) =>
        invoke(DESKTOP_CHROME_IPC.declaration, event, { document, declaration: { owner, revision, appearance } });
      expect(declare("shell", 1, { color: "#224466", height: 40 })).toMatchObject({ status: "applied" });
      store.push(JSON.stringify({ version: 1, stamp: { t: 1, id: "a" }, preferences: { colorScheme: "dark" } }));
      expect(win.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: "#224466", symbolColor: "#f3f4f6", height: 40 });
      expect(declare("shell", 2, { height: 42 })).toMatchObject({ appearance: { color: "#17191d", height: 42 } });
      expect(declare("other", 3, { height: 50 })).toMatchObject({
        status: "rejected",
        reason: "appearance-owner-conflict",
      });
      declare("shell", 4, null);
      declare("other", 5, { color: "#abcdef" });
      expect(declare("shell", 6, null)).toMatchObject({ appearance: { color: "#abcdef" } });
      expect(declare("other", 5, null)).toMatchObject({ status: "rejected" });
      expect(win.setBackgroundColor).toHaveBeenLastCalledWith("#17191d");
      win.webContents.emit(retireEvent);
      expect(declare("other", 7, { height: 40 })).toMatchObject({ reason: "stale-document" });
      expect(win.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: "#17191d", symbolColor: "#f3f4f6", height: 48 });
      dispose();
    },
  );
  it("cleans up after Electron destroys the BrowserWindow webContents getter", () => {
    const { win } = setup();
    const contents = win.webContents;
    Object.defineProperty(win, "webContents", {
      get: () => {
        throw new Error("Object has been destroyed");
      },
    });
    expect(() => win.emit("closed")).not.toThrow();
    expect(contents.listenerCount("did-navigate")).toBe(0);
    expect(win.handlers.size).toBe(0);
  });
});

it("keeps the current document live when navigation starts but is cancelled", () => {
  const { win, event, source, dispose, invoke, document } = setup();
  invoke(DESKTOP_CHROME_IPC.subscribe, event, "live");
  win.webContents.emit("did-start-navigation", {}, "https://example.com", false, true);
  expect(invoke(DESKTOP_CHROME_IPC.visualDocument, event)).toBe(document);
  win.focused = true;
  win.emit("focus");
  expect(source.send).toHaveBeenCalledOnce();
  win.webContents.emit("did-navigate", {}, "app://app/");
  expect(invoke(DESKTOP_CHROME_IPC.visualDocument, event)).not.toBe(document);
  dispose();
});

it("fans out system changes through one native listener and releases each closed window", () => {
  const windows = Array.from({ length: 12 }, () => setup());
  const [explicit, closed, ...following] = windows;
  try {
    explicit.store.push(
      JSON.stringify({ version: 1, stamp: { t: 1, id: "a" }, preferences: { colorScheme: "light" } }),
    );
    closed.win.emit("closed");
    expect(theme.on).toHaveBeenCalledTimes(1);
    expect(theme.off).not.toHaveBeenCalled();
    const notify = theme.on.mock.calls[0][1];
    theme.shouldUseDarkColors = true;
    notify();
    expect(explicit.win.setBackgroundColor).toHaveBeenCalledExactlyOnceWith("#ffffff");
    expect(closed.win.setBackgroundColor).not.toHaveBeenCalled();
    for (const item of following) expect(item.win.setBackgroundColor).toHaveBeenCalledExactlyOnceWith("#17191d");
  } finally {
    for (const item of windows) item.dispose();
  }
  expect(theme.off).toHaveBeenCalledExactlyOnceWith("updated", theme.on.mock.calls[0][1]);
});

it("rejects old declarations even before the next document requests its token", () => {
  const { win, event, store, dispose, invoke, document } = setup();
  try {
    expect(invoke(DESKTOP_CHROME_IPC.visualDocument, { ...event, allowed: false })).toBeNull();
    expect(invoke(DESKTOP_CHROME_IPC.visualDocument, event)).toBe(document);
    for (let i = 0; i < 20; i++) {
      win.webContents.emit("did-navigate", {}, "app://app/");
      expect(
        invoke(DESKTOP_CHROME_IPC.declaration, event, {
          document,
          declaration: { owner: "shell", revision: i + 1, appearance: null },
        }),
      ).toEqual({ status: "rejected", reason: "stale-document" });
      expect(invoke(DESKTOP_CHROME_IPC.visualDocument, event)).not.toBe(document);
    }
    expect(store.read().record).toBeNull();
  } finally {
    dispose();
  }
});

it.each(["light", "dark"] as const)(
  "applies global scheme changes while a fixed %s window keeps its own background and overlay",
  (appearance) => {
    const store = themeFixture();
    const primary = setup("win32", store);
    const fixed = setup("win32", store, appearance);
    let t = 0;
    try {
      fixed.declare(1, { height: 42 });
      // Explicit light, explicit dark, then auto on a light system.
      for (const [colorScheme, background] of [
        ["light", "#ffffff"],
        ["dark", "#17191d"],
        ["auto", "#ffffff"],
      ] as const) {
        expect(
          store.push(JSON.stringify({ version: 1, stamp: { t: ++t, id: "a" }, preferences: { colorScheme } })),
        ).toBe("ok");
        expect(primary.win.setBackgroundColor).toHaveBeenLastCalledWith(background);
        expect(fixed.win.setBackgroundColor).toHaveBeenLastCalledWith(appearance === "dark" ? "#17191d" : "#ffffff");
        expect(fixed.win.setTitleBarOverlay).toHaveBeenLastCalledWith({
          height: 42,
          color: appearance === "dark" ? "#17191d" : "#ffffff",
          symbolColor: appearance === "dark" ? "#f3f4f6" : "#202124",
        });
      }
      expect(primary.source.send).not.toHaveBeenCalled();
      expect(fixed.source.send).not.toHaveBeenCalled();
    } finally {
      primary.dispose();
      fixed.dispose();
    }
  },
);
