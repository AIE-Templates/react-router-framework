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
  screen: { getDisplayMatching: () => ({ workArea: { x: -1000, y: 0, width: 1000, height: 800 } }) },
  shell: { openExternal: native.openExternal },
  ipcMain: native.ipc,
}));

import { createBootProfile } from "./boot-profile.ts";
import { configureWindow, createAppWindow, type WindowOptions } from "./window.ts";

function setup(logRendererConsole = false) {
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    ipc: native.ipc,
    setWindowOpenHandler: vi.fn<Electron.WebContents["setWindowOpenHandler"]>(),
  });
  const win = Object.assign(new EventEmitter(), {
    webContents: contents,
    getBounds: () => ({ x: -1000, y: 0, width: 1000, height: 800 }),
  });
  native.createWindow.mockReturnValue(win);
  const log = {
    debug: vi.fn<(...args: unknown[]) => void>(),
    info: vi.fn<(...args: unknown[]) => void>(),
    warn: vi.fn<(...args: unknown[]) => void>(),
    error: vi.fn<(...args: unknown[]) => void>(),
  };
  const options: WindowOptions = {
    // The native constructor is stubbed; navigation handlers do not access the session.
    session: session.defaultSession,
    preloadPath: "preload.cjs",
    appVersion: "1",
    log,
    logRendererConsole,
    profile: createBootProfile(false),
  };
  configureWindow(createAppWindow(options), options, { reuse: () => false, adopt: vi.fn<() => void>() });
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

/** What the host creates a window with, and what it lets the renderer open one with. */
function windowOptions() {
  const { contents } = setup();
  const details: Electron.HandlerDetails = {
    url: "app://app/settings",
    features: "",
    frameName: "",
    disposition: "new-window",
    referrer: { url: "", policy: "default" },
  };
  return {
    created: native.createWindow.mock.calls.at(-1)?.[0],
    opened: contents.setWindowOpenHandler.mock.calls[0][0](details),
  };
}

it("keeps DevTools in dev and test builds and turns them off in release builds, for every window", () => {
  const test = windowOptions();
  expect(test.created).not.toHaveProperty("webPreferences.devTools");
  expect(test.opened).not.toHaveProperty("overrideBrowserWindowOptions.webPreferences.devTools");

  vi.stubGlobal("DESKTOP_BUILD_PROFILE", "release");
  try {
    const release = windowOptions();
    expect(release.created).toHaveProperty("webPreferences.devTools", false);
    expect(release.opened).toHaveProperty("overrideBrowserWindowOptions.webPreferences.devTools", false);
  } finally {
    vi.unstubAllGlobals();
  }
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

it.each([
  ["https://example.test/path", true],
  ["mailto:test@example.test", true],
  ["app://other/path", false],
  ["about:blank", false],
  ["file:///tmp/example", false],
] as const)("handles a popup targeting %s", (url, external) => {
  const { contents } = setup();
  const handler = contents.setWindowOpenHandler.mock.calls[0][0];
  expect(
    handler({ url, frameName: "", features: "", disposition: "new-window", referrer: { url: "", policy: "default" } }),
  ).toEqual({ action: "deny" });
  expect(native.openExternal.mock.calls).toEqual(external ? [[url]] : []);
});

it("staggering respects explicit coordinates, actual child size and the full-size opener's display", () => {
  const { contents } = setup();
  const request = contents.setWindowOpenHandler.mock.calls[0][0];
  const details: Electron.HandlerDetails = {
    url: "app://app/chat",
    features: "",
    frameName: "",
    disposition: "new-window",
    referrer: { url: "", policy: "default" },
  };
  expect(request(details).overrideBrowserWindowOptions).toMatchObject({ width: 952, height: 752 });
  const explicit = request({ ...details, features: "innerWidth=700,height=600" }).overrideBrowserWindowOptions;
  expect(explicit).not.toHaveProperty("width");
  expect(explicit).not.toHaveProperty("height");

  const placed = vi.fn<(point: { x: number; y: number }) => void>();
  const child = { getBounds: () => ({ width: 952, height: 752 }), setBounds: placed };
  const created = (options: { x?: number; y?: number }) =>
    contents.emit("did-create-window", child, { url: details.url, options });
  created({});
  created({ x: -800, y: 15 }); // Fully positioned popups retain their native placement and do not use a slot.
  created({ y: 10 });
  created({});
  expect(placed.mock.calls.map(([point]) => point)).toEqual([
    { x: -976, y: 24 },
    { x: -952, y: 10 },
    { x: -1000, y: 0 },
  ]);
});
