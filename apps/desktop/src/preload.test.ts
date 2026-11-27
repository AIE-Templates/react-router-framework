import type { DesktopBridge, DesktopWindowState } from "@repo/shared";
import { DESKTOP_CHROME_IPC, DESKTOP_PREFS_IPC, DESKTOP_VISUAL_IPC } from "@repo/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wire = vi.hoisted(() => ({
  workerCookies: vi.fn<() => void>(),
  cookies: vi.fn<() => void>(),
  sendSync: vi.fn<() => unknown>(() => ({ record: null, pending: false })),
  expose: vi.fn<(key: string, bridge: DesktopBridge) => void>(),
  invoke: vi.fn<(channel: string, payload: unknown) => Promise<unknown>>(),
  on: vi.fn<(channel: string, callback: (event: unknown, payload: unknown) => void) => void>(),
  off: vi.fn<(channel: string, callback: (event: unknown, payload: unknown) => void) => void>(),
  send: vi.fn<(channel: string, payload?: unknown) => void>(),
}));
vi.mock("@repo/electron-cookies/preload", () => ({
  installWindowCookiePreload: wire.cookies,
  installServiceWorkerCookiePreload: wire.workerCookies,
}));
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: wire.expose }, ipcRenderer: wire }));

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const state = (revision: number): DesktopWindowState => ({
  revision,
  focused: true,
  maximized: false,
  fullscreen: false,
});
async function load() {
  await import("./preload.ts");
  expect(wire.cookies).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ frame: window, isMainFrame: true }));
  return wire.expose.mock.calls[0][1];
}

const isMainFrameDescriptor = Object.getOwnPropertyDescriptor(process, "isMainFrame");
beforeEach(() => {
  Object.defineProperty(process, "isMainFrame", { configurable: true, value: true });
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("window", { addEventListener: vi.fn<(event: string, callback: () => void) => void>() });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (isMainFrameDescriptor) Object.defineProperty(process, "isMainFrame", isMainFrameDescriptor);
  else Reflect.deleteProperty(process, "isMainFrame");
});

describe("sandbox preload chrome bridge", () => {
  it("listens before the snapshot handshake, ignores older snapshots and cleans up", async () => {
    const pending = deferred();
    wire.invoke.mockReturnValueOnce(pending.promise);
    const bridge = await load();
    const listener = vi.fn<(value: DesktopWindowState) => void>();
    const stop = bridge.subscribeWindowState(listener);
    const token = wire.invoke.mock.calls[0][1];
    const onState = wire.on.mock.calls[0][1];
    onState({}, { token, state: state(2) });
    pending.resolve({ token, state: state(1) });
    await Promise.resolve();
    expect(listener).toHaveBeenCalledExactlyOnceWith(state(2));
    expect(wire.on.mock.invocationCallOrder[0]).toBeLessThan(wire.invoke.mock.invocationCallOrder[0]);
    stop();
    stop();
    expect(wire.send).toHaveBeenCalledWith(DESKTOP_CHROME_IPC.unsubscribe, token);
    expect(wire.off).toHaveBeenCalledExactlyOnceWith(DESKTOP_CHROME_IPC.state, onState);
    expect(wire.send).toHaveBeenCalledWith("desktop:first-paint");
  });

  it("discards late events and async replies from a previous subscription generation", async () => {
    const first = deferred();
    const second = deferred();
    wire.invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const bridge = await load();
    const oldListener = vi.fn<(value: DesktopWindowState) => void>();
    const stopOld = bridge.subscribeWindowState(oldListener);
    const oldToken = wire.invoke.mock.calls[0][1];
    stopOld();
    const listener = vi.fn<(value: DesktopWindowState) => void>();
    const stop = bridge.subscribeWindowState(listener);
    const token = wire.invoke.mock.calls[1][1];
    wire.on.mock.calls[1][1]({}, { token: oldToken, state: state(100) });
    first.resolve({ token: oldToken, state: state(100) });
    second.resolve({ token, state: state(0) });
    await Promise.resolve();
    expect(oldListener).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledExactlyOnceWith(state(0));
    stop();
  });

  it("rejects unsafe appearance before IPC and exposes structured native results", async () => {
    const bridge = await load();
    expect(await bridge.declareOverlayAppearance({ owner: "shell", revision: 1, appearance: { height: 500 } })).toEqual(
      {
        status: "rejected",
        reason: "invalid-appearance",
      },
    );
    expect(wire.invoke).not.toHaveBeenCalled();
    wire.invoke
      .mockResolvedValueOnce("document")
      .mockResolvedValueOnce({ status: "unsupported", reason: "native-overlay-appearance-unavailable" });
    expect(await bridge.declareOverlayAppearance({ owner: "shell", revision: 1, appearance: { height: 40 } })).toEqual({
      status: "unsupported",
      reason: "native-overlay-appearance-unavailable",
    });
    expect(wire.invoke).toHaveBeenCalledWith(DESKTOP_CHROME_IPC.declaration, {
      document: "document",
      declaration: { owner: "shell", revision: 1, appearance: { height: 40 } },
    });
  });
});

it("shares the document token for concurrent overlay declarations and retries a failed lookup", async () => {
  const bridge = await load();
  const declaration = { owner: "shell", revision: 1, appearance: null };
  wire.invoke.mockRejectedValueOnce(new Error("unavailable"));
  expect(await bridge.declareOverlayAppearance(declaration)).toMatchObject({ reason: "bridge-unavailable" });
  const lookup = deferred();
  wire.invoke.mockReturnValueOnce(lookup.promise).mockResolvedValue({ status: "unsupported", reason: "unavailable" });
  const writes = [1, 2].map((revision) => bridge.declareOverlayAppearance({ ...declaration, revision }));
  expect(wire.invoke.mock.calls.map(([channel]) => channel)).toEqual(Array(2).fill(DESKTOP_CHROME_IPC.visualDocument));
  lookup.resolve("document-token");
  await Promise.all(writes);
  expect(wire.invoke).toHaveBeenCalledWith(DESKTOP_CHROME_IPC.declaration, { document: "document-token", declaration });
});

describe("sandbox preload preference bridge", () => {
  it("rejects bad keys and values before IPC", async () => {
    const bridge = await load();
    // What a page's untyped script can pass.
    const loose: { setPref(this: void, key: unknown, value: unknown): Promise<unknown> } = bridge;
    expect(await bridge.setPref("bad key", "x")).toEqual({ status: "rejected", reason: "invalid-key" });
    expect(await loose.setPref("theme", { x: 1 })).toEqual({ status: "rejected", reason: "invalid-value" });
    expect(await loose.setPref("theme", null)).toEqual({ status: "rejected", reason: "invalid-value" });
    expect(await bridge.removePref("__proto__")).toEqual({ status: "rejected", reason: "invalid-key" });
    expect(wire.invoke).not.toHaveBeenCalled();
  });

  it("sends sets and removals, and passes on only well-formed results", async () => {
    const bridge = await load();
    wire.invoke.mockResolvedValueOnce({ status: "applied", extra: "dropped" });
    expect(await bridge.setPref("theme", "dark")).toEqual({ status: "applied" });
    expect(wire.invoke).toHaveBeenLastCalledWith(DESKTOP_PREFS_IPC.set, { key: "theme", value: "dark" });
    wire.invoke.mockResolvedValueOnce({ status: "applied" });
    expect(await bridge.removePref("theme")).toEqual({ status: "applied" });
    expect(wire.invoke).toHaveBeenLastCalledWith(DESKTOP_PREFS_IPC.set, { key: "theme", value: null });
    wire.invoke.mockResolvedValueOnce({ status: "rejected", reason: "too-large" });
    expect(await bridge.setPref("width", 280)).toEqual({ status: "rejected", reason: "too-large" });
    wire.invoke.mockResolvedValueOnce("nonsense");
    expect(await bridge.setPref("width", 280)).toEqual({ status: "rejected", reason: "invalid-response" });
    wire.invoke.mockRejectedValueOnce(new Error("no handler"));
    expect(await bridge.setPref("width", 280)).toEqual({ status: "rejected", reason: "bridge-unavailable" });
  });
});

it("does not expose the bridge, register teardown or announce paint in a sub-frame", async () => {
  Object.defineProperty(process, "isMainFrame", { configurable: true, value: false });
  const paint = vi.fn<() => void>();
  vi.stubGlobal("requestAnimationFrame", paint);
  await import("./preload.ts");
  expect(wire.cookies).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ frame: window, isMainFrame: false }));
  expect(wire.sendSync).not.toHaveBeenCalled();
  expect(wire.expose).not.toHaveBeenCalled();
  expect(window.addEventListener).not.toHaveBeenCalled();
  expect(paint).not.toHaveBeenCalled();
  expect(wire.send).not.toHaveBeenCalled();
});

it("catches peer writes during hydration and ignores a snapshot returned after unsubscribe", async () => {
  const bridge = await load();
  const change = vi.fn<() => void>();
  wire.invoke.mockResolvedValueOnce({ locale: "en" });
  const stop = bridge.subscribePreferences!({ locale: "zh" }, change);
  await vi.waitFor(() => expect(change).toHaveBeenCalledOnce());
  stop();
  const delayed = deferred();
  wire.invoke.mockReturnValueOnce(delayed.promise);
  const release = bridge.subscribePreferences!({}, change);
  release();
  delayed.resolve({ locale: "en" });
  await delayed.promise;
  expect(change).toHaveBeenCalledOnce();
});

it("ignores malformed preference subscriptions before registering native callbacks", async () => {
  const bridge = await load();
  wire.invoke.mockResolvedValue({});
  const subscribe = bridge.subscribePreferences!;
  for (const args of [
    [{}, null],
    [null, () => {}],
    [[], () => {}],
  ]) {
    Reflect.apply(subscribe, bridge, args)();
  }
  expect(wire.on).not.toHaveBeenCalled();
  expect(wire.invoke).not.toHaveBeenCalled();
});

it("samples the opener and child independently when both preloads run with the same process arguments", async () => {
  const opener = await load();
  expect(opener.visualSeed?.fixedAppearance).toBeUndefined();
  vi.resetModules();
  vi.clearAllMocks();
  wire.sendSync.mockReturnValueOnce({ record: null, pending: false, fixedAppearance: "dark" });
  const child = await load();
  expect(child.visualSeed?.fixedAppearance).toBe("dark");
  expect(wire.sendSync).toHaveBeenCalledExactlyOnceWith(DESKTOP_VISUAL_IPC.read);
});

it("samples once for prepaint, reads live pending state and classifies the application-level push", async () => {
  const bridge = await load();
  expect(bridge.visualSeed).toEqual({ record: null, pending: false });
  expect(wire.sendSync).toHaveBeenCalledExactlyOnceWith(DESKTOP_VISUAL_IPC.read);
  wire.sendSync.mockReturnValueOnce({ record: "live", pending: true });
  expect(bridge.readVisual()).toEqual({ record: "live", pending: true });
  wire.invoke
    .mockResolvedValueOnce("ok")
    .mockResolvedValueOnce("failed")
    .mockRejectedValueOnce(new Error("IPC"))
    .mockResolvedValueOnce(null);
  for (const expected of ["ok", "failed", "unavailable", "unavailable"])
    expect(await bridge.pushVisual("raw")).toBe(expected);
  expect(wire.invoke.mock.calls).toEqual(Array.from({ length: 4 }, () => [DESKTOP_VISUAL_IPC.push, "raw"]));
});
it("survives an unavailable seed and distinguishes a denied read from an empty mirror", async () => {
  wire.sendSync
    .mockImplementationOnce(() => {
      throw new Error("unavailable");
    })
    .mockReturnValueOnce(null);
  const bridge = await load();
  expect(bridge.visualSeed).toBeNull();
  expect(() => bridge.readVisual()).toThrow("Visual mirror unavailable");
  expect(bridge.readVisual()).toEqual({ record: null, pending: false });
});

it("runs only the worker cookie installer without window globals in a service-worker preload", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "type");
  Object.defineProperty(process, "type", { configurable: true, value: "service-worker" });
  vi.stubGlobal("window", undefined);
  try {
    await import("./preload.ts");
    expect(wire.workerCookies).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ appOrigin: "app://app", ipcRenderer: wire }),
    );
    expect(wire.cookies).not.toHaveBeenCalled();
    expect(wire.expose).not.toHaveBeenCalled();
    expect(wire.sendSync).not.toHaveBeenCalled();
    expect(wire.send).not.toHaveBeenCalled();
  } finally {
    if (descriptor) Object.defineProperty(process, "type", descriptor);
    else Reflect.deleteProperty(process, "type");
  }
});
