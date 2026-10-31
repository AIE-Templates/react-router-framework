import { EventEmitter } from "node:events";

import { DESKTOP_CHROME_IPC } from "@repo/shared";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { ipc, handlers, theme } = vi.hoisted(() => {
  const registry = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers: registry,
    theme: {
      shouldUseDarkColors: false,
      on: vi.fn<(event: string, handler: () => void) => void>(),
      off: vi.fn<(event: string, handler: () => void) => void>(),
    },
    ipc: {
      handle: vi.fn<(channel: string, handler: (...args: unknown[]) => unknown) => unknown>((channel, handler) =>
        registry.set(channel, handler),
      ),
      removeHandler: vi.fn<(channel: string) => unknown>((channel) => registry.delete(channel)),
      on: vi.fn<(channel: string, handler: (...args: unknown[]) => void) => void>(),
      off: vi.fn<(channel: string, handler: (...args: unknown[]) => void) => void>(),
    },
  };
});
vi.mock("electron", () => ({ ipcMain: ipc, nativeTheme: theme }));

import { resolveChromePolicy } from "./chrome-policy.ts";
import { installWindowChrome } from "./chrome.ts";

class FakeWindow extends EventEmitter {
  focused = false;
  maximized = false;
  fullscreen = false;
  webContents = new EventEmitter();
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
const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(...args);

const trusted = (input: IpcMainEvent | IpcMainInvokeEvent) => "allowed" in input && input.allowed === true;

function setup(platform = "win32") {
  const win = new FakeWindow();
  const source = frame();
  const event = { senderFrame: source, allowed: true };
  const store = { current: () => "auto" as const, save: vi.fn<() => boolean>(() => true) };
  const dispose = installWindowChrome(win, resolveChromePolicy({ platform }), trusted, log, store);
  return { win, event, source, dispose, store };
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  theme.shouldUseDarkColors = false;
});

describe("window chrome bridge", () => {
  it("validates senders and sends actual initial facts followed by changed source revisions", () => {
    const { win, event, source, dispose } = setup();
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
    const { win, event, source, dispose } = setup();
    invoke(DESKTOP_CHROME_IPC.subscribe, event, "old");
    win.webContents.emit("did-start-navigation", {}, "app://app/#one", true, true);
    win.focused = true;
    win.emit("focus");
    expect(source.send).toHaveBeenCalledTimes(1);
    win.webContents.emit("did-start-navigation", {}, "app://app/", false, true);
    win.maximized = true;
    win.emit("maximize");
    expect(source.send).toHaveBeenCalledTimes(1);
    const fresh = frame();
    expect(invoke(DESKTOP_CHROME_IPC.subscribe, { ...event, senderFrame: fresh }, "new")).toMatchObject({
      token: "new",
      state: { focused: true, maximized: true },
    });
    const unsubscribe = ipc.on.mock.calls.find(([channel]) => channel === DESKTOP_CHROME_IPC.unsubscribe)![1];
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

  it("bounds appearance updates, avoids duplicate writes and clears all listeners on close", () => {
    const { win, event } = setup();
    expect(invoke(DESKTOP_CHROME_IPC.appearance, { ...event, allowed: false }, { height: 40 })).toEqual({
      status: "rejected",
      reason: "untrusted-sender",
    });
    expect(invoke(DESKTOP_CHROME_IPC.appearance, event, { height: 400 })).toEqual({
      status: "rejected",
      reason: "invalid-appearance",
    });
    expect(invoke(DESKTOP_CHROME_IPC.appearance, event, { height: 40 })).toMatchObject({
      status: "applied",
      appearance: { height: 40 },
    });
    invoke(DESKTOP_CHROME_IPC.appearance, event, { height: 40 });
    expect(win.setTitleBarOverlay).toHaveBeenCalledTimes(1);
    win.emit("closed");
    expect(handlers.size).toBe(0);
    expect(win.listenerCount("focus")).toBe(0);
    expect(win.webContents.listenerCount("did-start-navigation")).toBe(0);
  });

  it("reports macOS runtime appearance updates unavailable without moving native controls", () => {
    const { win, event, dispose } = setup("darwin");
    expect(invoke(DESKTOP_CHROME_IPC.appearance, event, { height: 40 })).toMatchObject({ status: "unsupported" });
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
  it("replaces a disposed window's handlers before reopen and ignores its late close", () => {
    const old = setup();
    const fresh = setup();
    old.win.emit("closed");
    expect(invoke(DESKTOP_CHROME_IPC.subscribe, fresh.event, "reopened")).toMatchObject({ token: "reopened" });
    fresh.win.focused = true;
    fresh.win.emit("focus");
    expect(fresh.source.send).toHaveBeenCalledTimes(1);
    expect(old.win.listenerCount("focus")).toBe(0);
    fresh.dispose();
  });
  it("keeps overrides separate from theme backgrounds and fills missing overlay fields from the theme", () => {
    const { win, event, dispose } = setup();
    const updated = theme.on.mock.calls.find(([name]) => name === "updated")![1];
    invoke(DESKTOP_CHROME_IPC.appearance, event, { height: 40 });
    theme.shouldUseDarkColors = true;
    updated();
    expect(win.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: "#17191d", symbolColor: "#f3f4f6", height: 40 });
    invoke(DESKTOP_CHROME_IPC.appearance, event, { color: "#224466" });
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith("#17191d");
    const writes = win.setTitleBarOverlay.mock.calls.length;
    theme.shouldUseDarkColors = false;
    updated();
    expect(win.setTitleBarOverlay).toHaveBeenCalledTimes(writes + 1);
    expect(win.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: "#224466", symbolColor: "#202124", height: 40 });
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith("#ffffff");
    dispose();
  });
  it("keeps native theme, background, overlay support and persistence results independent", () => {
    const { win, event, store, dispose } = setup("darwin");
    const send = (preference: string, revision: number) =>
      invoke(DESKTOP_CHROME_IPC.visualTheme, event, { document: "doc", revision, preference });
    expect(send("dark", 1)).toEqual({
      status: "processed",
      background: "applied",
      overlay: "unsupported",
      persistence: "saved",
    });
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith("#17191d");
    theme.shouldUseDarkColors = false;
    theme.on.mock.calls.find(([name]) => name === "updated")![1]();
    expect(win.setBackgroundColor).toHaveBeenCalledTimes(1);
    store.save.mockReturnValueOnce(false);
    expect(send("auto", 2)).toMatchObject({ persistence: "failed", background: "applied" });
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith("#ffffff");
    expect(send("dark", 1)).toMatchObject({ status: "rejected" });
    win.webContents.emit("did-start-navigation", {}, "app://app/", false, true);
    expect(send("dark", 3)).toMatchObject({ status: "rejected" });
    expect(
      invoke(DESKTOP_CHROME_IPC.visualTheme, event, { document: "new", revision: 1, preference: "light" }),
    ).toMatchObject({ status: "processed" });
    expect(win.setTitleBarOverlay).not.toHaveBeenCalled();
    dispose();
  });
  it("replaces and releases complete declarations without stale owners or requests clearing new values", () => {
    const { win, event, dispose } = setup();
    const declare = (owner: string, revision: number, appearance: unknown) =>
      invoke(DESKTOP_CHROME_IPC.declaration, event, { owner, revision, appearance });
    expect(declare("shell", 1, { color: "#224466", height: 40 })).toMatchObject({ status: "applied" });
    invoke(DESKTOP_CHROME_IPC.visualTheme, event, { document: "doc", revision: 1, preference: "dark" });
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
    win.webContents.emit("did-start-navigation", {}, "app://app/", false, true);
    expect(win.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: "#17191d", symbolColor: "#f3f4f6", height: 48 });
    dispose();
  });
  it("cleans up after Electron destroys the BrowserWindow webContents getter", () => {
    const { win } = setup();
    const contents = win.webContents;
    Object.defineProperty(win, "webContents", {
      get: () => {
        throw new Error("Object has been destroyed");
      },
    });
    expect(() => win.emit("closed")).not.toThrow();
    expect(contents.listenerCount("did-start-navigation")).toBe(0);
    expect(handlers.size).toBe(0);
  });
});
