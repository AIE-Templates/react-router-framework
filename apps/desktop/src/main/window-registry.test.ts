import { EventEmitter } from "node:events";

import { session } from "electron";
import { afterEach, expect, it, vi } from "vitest";

import { createBootProfile } from "./boot-profile.ts";
import type { RecoveryChoice } from "./recovery.ts";
import { createWindowRegistry } from "./window-registry.ts";

const made: FakeWindow[] = [];
class FakeWindow extends EventEmitter {
  destroyed = false;
  minimized = false;
  visible = true;
  pid = 40;
  crashed = false;
  url = "";
  webContents = Object.assign(new EventEmitter(), {
    id: made.length + 1,
    ipc: new EventEmitter(),
    getURL: () => this.url,
    getOSProcessId: () => (this.crashed ? 0 : this.pid),
    isCrashed: () => this.crashed,
    setWindowOpenHandler: vi.fn<Electron.WebContents["setWindowOpenHandler"]>(),
  });
  constructor() {
    super();
    made.push(this);
  }
  isDestroyed = () => this.destroyed;
  isMinimized = () => this.minimized;
  isVisible = () => this.visible && !this.minimized;
  show = vi.fn<() => void>(() => {
    this.visible = true;
  });
  restore = vi.fn<() => void>(() => {
    this.minimized = false;
  });
  focus = vi.fn<() => void>();
  loadURL = vi.fn<(url: string) => Promise<void>>((url) => {
    this.url = url;
    return Promise.resolve();
  });
  close = vi.fn<() => void>(() => this.destroy());
  destroy() {
    this.destroyed = true;
    this.emit("closed");
  }
  commit(url: string) {
    this.url = url;
    this.webContents.emit("did-navigate", {}, url);
    this.webContents.emit("did-finish-load");
  }
}
vi.mock("electron", () => ({
  get BrowserWindow() {
    return FakeWindow;
  },
  session: { defaultSession: {} },
}));

function setup() {
  const choices: ((choice: RecoveryChoice) => void)[] = [];
  const askRecovery = vi.fn<Parameters<typeof createWindowRegistry>[0]["askRecovery"]>(
    () => new Promise((resolve) => choices.push(resolve)),
  );
  const registry = createWindowRegistry({
    session: session.defaultSession,
    profile: createBootProfile(false),
    preloadPath: "",
    appVersion: "1",
    log: {
      info: vi.fn<() => void>(),
      warn: vi.fn<() => void>(),
      error: vi.fn<() => void>(),
      debug: vi.fn<() => void>(),
    },
    keyForUrl: (url) => (url.pathname === "/settings" ? "settings" : undefined),
    askRecovery,
  });
  return { registry, choices, askRecovery };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => {
  for (const win of made) if (!win.destroyed) win.destroy();
  made.length = 0;
});

it("adopts native and host-created windows and reuses only their requested identities", () => {
  const { registry } = setup();
  const primary = registry.open("app://app/", "primary").window;
  const home = made[0];
  home.visible = false;
  expect(registry.byContentsId(home.webContents.id)).toBe(primary);
  expect(registry.open("app://app/", "primary")).toEqual({ window: primary, loaded: undefined });
  expect(home.show).not.toHaveBeenCalled();
  const child = new FakeWindow();
  home.webContents.emit("did-create-window", child, { url: "app://app/settings", options: { x: 100, y: 100 } });
  expect(registry.byContentsId(child.webContents.id)).toBe(child);
  child.minimized = true;
  expect(registry.open("app://app/settings?from=menu").window).toBe(child);
  expect(child.restore).toHaveBeenCalledOnce();
  expect(child.focus).toHaveBeenCalledOnce();
  expect(child.loadURL).not.toHaveBeenCalled();
  const duplicate = new FakeWindow();
  home.webContents.emit("did-create-window", duplicate, { url: "app://app/settings", options: { x: 100, y: 100 } });
  expect(duplicate.destroyed).toBe(true);
  expect([...registry.windows()]).toEqual([primary, child]);
  child.commit("app://app/chat");
  expect(registry.find("settings")).toBeUndefined();
  child.webContents.emit("did-navigate-in-page", {}, "app://app/settings", true);
  expect(registry.find("settings")).toBe(child);
  child.webContents.emit("did-navigate-in-page", {}, "app://app/chat", true);
  const settings = registry.open("app://app/settings").window;
  expect(settings).not.toBe(child);
  expect(registry.find("settings")).toBe(settings);
  expect(registry.open("app://app/").window).not.toBe(primary);

  home.destroyed = true;
  const reopened = registry.open("app://app/", "primary").window;
  home.emit("closed");
  expect(registry.find("primary")).toBe(reopened);
  expect(registry.byContentsId(home.webContents.id)).toBeUndefined();
  expect(() => registry.open("https://example.test/settings")).toThrow("application URLs");
});

it("shares one choice per affected renderer and keeps its replacement when the old owner settles late", async () => {
  const { registry, choices, askRecovery } = setup();
  for (const path of ["owner", "peer", "next", "unrelated"]) registry.open("app://app/" + path);
  const [owner, peer, next, unrelated] = made;
  unrelated.pid++;
  for (const win of made) win.commit(win.url);
  owner.emit("unresponsive");
  peer.emit("unresponsive");
  unrelated.emit("unresponsive");
  await flush();
  expect(askRecovery.mock.calls.map(([win, kind, shared]) => [win, kind, shared])).toEqual([
    [owner, "unresponsive", true],
    [unrelated, "unresponsive", false],
  ]);
  owner.emit("responsive");
  expect(askRecovery.mock.calls[0][3].aborted).toBe(true);
  next.emit("unresponsive");
  await flush();
  expect(askRecovery.mock.calls[2].slice(0, 3)).toEqual([next, "unresponsive", true]);
  choices[0]("dismissed");
  await flush();
  expect(askRecovery).toHaveBeenCalledTimes(3);
  choices[2]("close");
  choices[1]("wait");
  await flush();
  expect([...registry.windows()]).toEqual([owner, unrelated]);
});

it("uses the last committed PID after a crash and ignores the finish of Chromium's error document", async () => {
  const { registry, askRecovery, choices } = setup();
  registry.utilityChanged({ state: "starting", generation: 1, restarted: false });
  for (const path of ["one", "two"]) registry.open("app://app/" + path);
  for (const win of made) {
    win.commit(win.url);
    win.crashed = true;
    win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    win.webContents.emit("did-fail-load", {}, -105, "", win.url, true);
    win.webContents.emit("did-finish-load");
  }
  registry.utilityChanged({ state: "failed", generation: 1, restarted: false });
  await flush();
  expect(askRecovery).toHaveBeenCalledExactlyOnceWith(made[0], "failure", true, expect.any(AbortSignal));
  made[0].destroy();
  choices[0]("dismissed");
  await flush();
  expect(askRecovery).toHaveBeenLastCalledWith(made[1], "failure", false, expect.any(AbortSignal));
  choices[1]("wait");
  await flush();
  expect([...registry.windows()]).toEqual([made[1]]);
});
