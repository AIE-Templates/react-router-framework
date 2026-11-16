import { EventEmitter } from "node:events";

import { session } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  createWindow: vi.fn<(...args: unknown[]) => object>(),
  openExternal: vi.fn<(_url: string) => Promise<void>>(() => Promise.resolve()),
  ipc: { on: vi.fn<(...args: unknown[]) => void>(), off: vi.fn<(...args: unknown[]) => void>() },
}));
vi.mock("electron", () => ({
  BrowserWindow: function BrowserWindow(options: unknown) {
    return native.createWindow(options);
  },
  session: { defaultSession: {} },
  shell: { openExternal: native.openExternal },
  ipcMain: native.ipc,
}));

import { createBootProfile } from "./boot-profile.ts";
import { createMainWindow } from "./window.ts";

function setup(logRendererConsole = false) {
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    setWindowOpenHandler: vi.fn<(...args: unknown[]) => void>(),
  });
  const win = Object.assign(new EventEmitter(), { webContents: contents });
  native.createWindow.mockReturnValue(win);
  const log = {
    debug: vi.fn<(...args: unknown[]) => void>(),
    info: vi.fn<(...args: unknown[]) => void>(),
    warn: vi.fn<(...args: unknown[]) => void>(),
    error: vi.fn<(...args: unknown[]) => void>(),
  };
  createMainWindow({
    // The native constructor is stubbed; navigation handlers do not access the session.
    session: session.defaultSession,
    preloadPath: "preload.cjs",
    appVersion: "1",
    log,
    logRendererConsole,
    profile: createBootProfile(false),
  });
  return { contents, log };
}

beforeEach(() => vi.clearAllMocks());

describe("window navigation confinement", () => {
  it.each(["will-frame-navigate", "will-redirect"])("blocks external subframes on %s without opening them", (event) => {
    const { contents, log } = setup();
    const details = {
      url: "https://example.test/frame?token=private",
      isMainFrame: false,
      preventDefault: vi.fn<(...args: unknown[]) => void>(),
    };
    contents.emit(event, details);
    expect(details.preventDefault).toHaveBeenCalledOnce();
    expect(native.openExternal).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith({ path: "https://example.test/frame" }, "blocked sub-frame navigation");
  });

  it.each(["will-frame-navigate", "will-redirect"])("allows application subframes on %s", (event) => {
    const { contents } = setup();
    const details = {
      url: "app://app/frame",
      isMainFrame: false,
      preventDefault: vi.fn<(...args: unknown[]) => void>(),
    };
    contents.emit(event, details);
    expect(details.preventDefault).not.toHaveBeenCalled();
    expect(native.openExternal).not.toHaveBeenCalled();
  });

  it.each(["will-navigate", "will-redirect"])(
    "preserves main-frame external handling on %s using event details",
    (event) => {
      const { contents } = setup();
      const details = {
        url: "https://example.test/main",
        isMainFrame: true,
        preventDefault: vi.fn<(...args: unknown[]) => void>(),
      };
      // Only modern event details are supplied; deprecated positional URL arguments are not needed.
      contents.emit(event, details);
      expect(details.preventDefault).toHaveBeenCalledOnce();
      expect(native.openExternal).toHaveBeenCalledExactlyOnceWith(details.url);
    },
  );

  it("leaves main-frame navigation to will-navigate and blocks disallowed redirect schemes", () => {
    const { contents } = setup();
    const details = {
      url: "file:///private/example",
      isMainFrame: true,
      preventDefault: vi.fn<(...args: unknown[]) => void>(),
    };
    contents.emit("will-frame-navigate", details);
    expect(details.preventDefault).not.toHaveBeenCalled();
    contents.emit("will-redirect", details);
    expect(details.preventDefault).toHaveBeenCalledOnce();
    expect(native.openExternal).not.toHaveBeenCalled();
  });
});

it("explicitly disables sub-frame Node integration and webviews", () => {
  setup();
  expect(native.createWindow).toHaveBeenCalledWith(
    expect.objectContaining({
      webPreferences: expect.objectContaining({ nodeIntegrationInSubFrames: false, webviewTag: false }),
    }),
  );
});

it("logs only main-frame console messages and redacts source and message URLs", () => {
  const { contents, log } = setup(true);
  const event = {
    frame: contents.mainFrame,
    level: "error",
    sourceId: "app://app/entry.js?token=secret#private",
    message: "Failed https://user:password@example.test/api?token=secret",
  };
  contents.emit("console-message", event);
  contents.emit("console-message", { ...event, frame: {} });
  expect(log.info).toHaveBeenCalledExactlyOnceWith(
    { level: "error", source: "app://app/entry.js" },
    "renderer: Failed https://example.test/api",
  );
});
