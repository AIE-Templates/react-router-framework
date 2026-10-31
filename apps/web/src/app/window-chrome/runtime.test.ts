import type { WindowChromeBridge, DesktopWindowState, OverlayAppearanceResult } from "@repo/shared";
import { describe, expect, it, vi } from "vitest";

import { createWindowChromeRuntime } from "./runtime";

function bridge() {
  let listener: ((state: DesktopWindowState) => void) | undefined;
  const release = vi.fn<() => void>();
  const value: WindowChromeBridge = {
    platform: "darwin",
    version: "1",
    bootstrap: {
      protocolVersion: 1,
      shell: { kind: "desktop", platform: "darwin", osVersion: "26" },
      mode: "native-overlay",
    },
    subscribeWindowState: vi.fn<WindowChromeBridge["subscribeWindowState"]>((next) => {
      listener = next;
      return release;
    }),
    updateOverlayAppearance: vi.fn<WindowChromeBridge["updateOverlayAppearance"]>(async () => ({
      status: "applied",
      appearance: { color: "#ffffff" },
    })),
  };
  return {
    value,
    release,
    emit: (revision: number) => listener?.({ revision, focused: true, maximized: false, fullscreen: false }),
  };
}

describe("document window chrome runtime", () => {
  it("preserves initial mode and fullscreen facts without requiring a host request protocol", () => {
    const runtime = createWindowChromeRuntime({
      shell: { kind: "desktop", platform: "darwin", osVersion: "26" },
      mode: "native-overlay",
      fullscreen: true,
    });
    expect(runtime.getServerSnapshot()).toMatchObject({ mode: "native-overlay", fullscreen: true });
    runtime.connect(bridge().value);
    expect(runtime.getSnapshot().diagnostic).toBeUndefined();
  });

  it("lets preload replace mismatched SSR facts and reports only differing field names", () => {
    const runtime = createWindowChromeRuntime({ shell: { kind: "desktop", platform: "win32", osVersion: "10" } });
    runtime.connect(bridge().value);
    expect(runtime.getSnapshot()).toMatchObject({
      shell: { platform: "darwin", osVersion: "26" },
      mode: "native-overlay",
      diagnostic: "host-mismatch",
      diagnosticFields: ["platform", "osVersion", "mode"],
    });
  });

  it("keeps the serialized identity until connect and retains the server snapshot", () => {
    const runtime = createWindowChromeRuntime();
    const initial = runtime.getServerSnapshot();
    const host = bridge();
    expect(runtime.getSnapshot().shell.kind).toBe("web");
    runtime.connect(host.value);
    expect(runtime.getSnapshot()).toMatchObject({
      shell: { kind: "desktop" },
      enhancement: "available",
      mode: "native-overlay",
    });
    expect(runtime.getServerSnapshot()).toBe(initial);
    expect(initial.shell.kind).toBe("web");
  });

  it("does not call invalid or ordinary web bridges and reports unsupported writes", async () => {
    const runtime = createWindowChromeRuntime();
    const host = bridge();
    runtime.connect({ ...host.value, bootstrap: null });
    expect(host.value.subscribeWindowState).not.toHaveBeenCalled();
    expect(runtime.getSnapshot()).toMatchObject({ enhancement: "unavailable", diagnostic: "invalid-bootstrap" });
    expect(await runtime.updateOverlayAppearance({ color: "#ffffff" })).toMatchObject({ status: "unsupported" });
    runtime.connect(undefined);
    expect(runtime.getSnapshot().shell.kind).toBe("web");
  });

  it("drops stale revisions and old document callbacks, resets revision on reconnect, and releases subscriptions", () => {
    const runtime = createWindowChromeRuntime();
    const old = bridge();
    const notify = vi.fn<() => void>();
    const unsubscribe = runtime.subscribe(notify);
    const stop = runtime.connect(old.value);
    old.emit(10);
    old.emit(9);
    expect(runtime.getSnapshot().windowState?.revision).toBe(10);
    stop();
    expect(old.release).toHaveBeenCalledOnce();
    const current = bridge();
    runtime.connect(current.value);
    expect(runtime.getSnapshot().windowState).toBeUndefined();
    current.emit(1);
    old.emit(20);
    expect(runtime.getSnapshot().windowState?.revision).toBe(1);
    unsubscribe();
    notify.mockClear();
    current.emit(2);
    expect(notify).not.toHaveBeenCalled();
  });

  it("discards an appearance response from a previous connection", async () => {
    const runtime = createWindowChromeRuntime();
    const host = bridge();
    let resolve!: (value: OverlayAppearanceResult) => void;
    host.value.updateOverlayAppearance = () =>
      new Promise((next) => {
        resolve = next;
      });
    runtime.connect(host.value);
    const result = runtime.updateOverlayAppearance({ color: "#ffffff" });
    runtime.connect(bridge().value);
    resolve({ status: "applied", appearance: { color: "#ffffff" } });
    expect(await result).toEqual({ status: "rejected", reason: "desktop-document-changed" });
  });

  it("keeps a failed bridge unavailable without blocking the initial document", () => {
    const runtime = createWindowChromeRuntime({ shell: { kind: "desktop", platform: "win32", osVersion: "10" } });
    const host = bridge();
    host.value.subscribeWindowState = () => {
      throw new Error("disconnected");
    };
    expect(() => runtime.connect(host.value)).not.toThrow();
    expect(runtime.getSnapshot()).toMatchObject({ enhancement: "unavailable", diagnostic: "bridge-failed" });
  });
});

it("preserves declaration order when a provider recreates its runtime on the same document bridge", async () => {
  const host = bridge();
  let acceptedRevision = 0;
  host.value.declareOverlayAppearance = async ({ revision, appearance }) => {
    if (revision <= acceptedRevision) return { status: "rejected", reason: "stale-declaration" };
    acceptedRevision = revision;
    return { status: "applied", appearance: appearance ?? { height: 48 } };
  };
  const first = createWindowChromeRuntime();
  const disconnect = first.connect(host.value);
  await first.declareOverlayAppearance("first", { height: 40 });
  await first.declareOverlayAppearance("first", null);
  disconnect();
  const replacement = createWindowChromeRuntime();
  const release = replacement.connect(host.value);
  expect(await replacement.declareOverlayAppearance("replacement", { height: 50 })).toMatchObject({
    status: "applied",
  });
  release();
});
