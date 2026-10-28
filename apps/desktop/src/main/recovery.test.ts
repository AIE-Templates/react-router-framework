import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWindowRecovery, RECOVERY_STABLE_MS, type RecoveryChoice } from "./recovery.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function setup() {
  const window = { isDestroyed: vi.fn<() => boolean>(() => false) };
  let current = window;
  const choices: ReturnType<typeof deferred<RecoveryChoice>>[] = [];
  const reload = vi.fn<(_: typeof window, url: string) => void | Promise<unknown>>();
  const close = vi.fn<() => void>();
  const cancelReload = vi.fn<() => void>();
  const showDialog = vi.fn<() => Promise<RecoveryChoice>>(() => {
    const choice = deferred<RecoveryChoice>();
    choices.push(choice);
    return choice.promise;
  });
  const onError = vi.fn<(error: unknown) => void>();
  const recovery = createWindowRecovery({
    current: () => current,
    isAppUrl: (url) => url.startsWith("app://app/"),
    reload,
    cancelReload,
    close,
    showDialog,
    onError,
  });
  recovery.track(window, "app://app/start");
  return {
    window,
    recovery,
    reload,
    cancelReload,
    close,
    showDialog,
    choices,
    onError,
    replace: () => {
      current = { isDestroyed: vi.fn<() => boolean>(() => false) };
      recovery.track(current, "app://app/new");
      return current;
    },
    fail: () => recovery.didFailLoad(window, { errorCode: -105, isMainFrame: true }),
  };
}
const flush = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("window recovery", () => {
  it.each(["wait", "close"] as const)("offers %s while a reload is still pending", async (choice) => {
    const s = setup();
    s.reload.mockReturnValueOnce(new Promise(() => {}));
    s.fail();
    s.recovery.unresponsive(s.window);
    await flush();
    expect(s.showDialog).toHaveBeenCalledExactlyOnceWith(s.window, "unresponsive");
    s.choices[0].resolve(choice);
    await flush();
    expect(s.close).toHaveBeenCalledTimes(choice === "close" ? 1 : 0);
    expect(s.reload).toHaveBeenCalledTimes(1);
    expect(s.cancelReload).not.toHaveBeenCalled();
    s.recovery.shutdown();
  });

  it("supersedes a stalled reload and ignores its late settlement", async () => {
    const s = setup();
    let rejectOld!: (error: Error) => void;
    s.reload.mockReturnValueOnce(new Promise((_resolve, reject) => (rejectOld = reject)));
    const replacement = deferred<unknown>();
    s.reload.mockReturnValueOnce(replacement.promise);
    s.fail();
    s.recovery.unresponsive(s.window);
    await flush();
    s.choices[0].resolve("reload");
    await flush();
    expect(s.cancelReload).toHaveBeenCalledTimes(1);
    expect(s.reload).toHaveBeenCalledTimes(2);
    rejectOld(new Error("old load cancelled"));
    await flush();
    s.fail();
    await flush();
    // The old promise must not unlock the replacement or start a premature dialog.
    expect(s.showDialog).toHaveBeenCalledTimes(1);
    replacement.resolve(undefined);
    await flush();
    expect(s.showDialog).toHaveBeenCalledTimes(2);
    expect(s.reload).toHaveBeenCalledTimes(2);
    s.recovery.shutdown();
  });

  it("discards a stalled-load retry choice after the renderer becomes responsive", async () => {
    const s = setup();
    s.reload.mockReturnValueOnce(new Promise(() => {}));
    s.fail();
    s.recovery.unresponsive(s.window);
    await flush();
    s.recovery.responsive(s.window);
    s.choices[0].resolve("reload");
    await flush();
    expect(s.cancelReload).not.toHaveBeenCalled();
    expect(s.reload).toHaveBeenCalledTimes(1);
    s.recovery.shutdown();
  });

  it("ignores aborted navigation, subframes and clean renderer exits", async () => {
    const s = setup();
    s.recovery.didFailLoad(s.window, { errorCode: -3, isMainFrame: true });
    s.recovery.didFailLoad(s.window, { errorCode: -105, isMainFrame: false });
    s.recovery.rendererGone(s.window, "clean-exit");
    await flush();
    expect(s.reload).not.toHaveBeenCalled();
    expect(s.showDialog).not.toHaveBeenCalled();
  });

  it("reloads the initial validated document once, then offers native choices", async () => {
    const s = setup();
    s.fail();
    await flush();
    expect(s.reload).toHaveBeenCalledExactlyOnceWith(s.window, "app://app/start");
    s.fail();
    await flush();
    expect(s.showDialog).toHaveBeenCalledExactlyOnceWith(s.window, "failure");
    s.choices[0].resolve("reload");
    await flush();
    expect(s.reload).toHaveBeenCalledTimes(2);
    s.fail();
    await flush();
    expect(s.reload).toHaveBeenCalledTimes(2);
    expect(s.showDialog).toHaveBeenCalledTimes(2);
  });

  it("only renews the auto quota after a successful document is stable for 30 seconds", async () => {
    const s = setup();
    s.fail();
    await flush();
    s.recovery.documentLoaded(s.window, "app://app/current");
    await vi.advanceTimersByTimeAsync(RECOVERY_STABLE_MS - 1);
    s.recovery.rendererGone(s.window, "crashed");
    await flush();
    expect(s.reload).toHaveBeenCalledTimes(1);
    s.recovery.documentLoaded(s.window, "app://app/current");
    await vi.advanceTimersByTimeAsync(RECOVERY_STABLE_MS);
    s.recovery.rendererGone(s.window, "crashed");
    await flush();
    expect(s.reload).toHaveBeenCalledExactlyOnceWith(s.window, "app://app/start");
    // The old native dialog must settle before another action can run.
    s.choices[0].resolve("reload");
    await flush();
    expect(s.reload).toHaveBeenCalledTimes(2);
    expect(s.reload).toHaveBeenLastCalledWith(s.window, "app://app/current");
  });

  it("defers failures and manual retries during utility startup and deduplicates readiness", async () => {
    const s = setup();
    s.recovery.utilityStarting(2);
    s.fail();
    await flush();
    expect(s.reload).not.toHaveBeenCalled();
    s.recovery.utilityReady(2, { restarted: true });
    s.recovery.utilityReady(2, { restarted: true });
    await flush();
    expect(s.reload).toHaveBeenCalledTimes(1);
    s.fail();
    await flush();
    s.choices[0].resolve("reload");
    s.recovery.utilityStarting(3);
    await flush();
    expect(s.reload).toHaveBeenCalledTimes(1);
    s.recovery.utilityReady(3, { restarted: true });
    await flush();
    // The stale dialog result cannot create a manual retry; auto quota is already used.
    expect(s.reload).toHaveBeenCalledTimes(1);
    expect(s.showDialog).toHaveBeenCalledTimes(2);
  });

  it("preserves an explicit retry waiting for utility readiness", async () => {
    const s = setup();
    s.recovery.utilityStarting(1);
    s.recovery.utilityFailed(1);
    await flush();
    s.choices[0].resolve("reload");
    await flush();
    expect(s.reload).not.toHaveBeenCalled();
    s.recovery.utilityStarting(2);
    s.recovery.utilityReady(2, { restarted: true });
    await flush();
    expect(s.reload).toHaveBeenCalledTimes(1);
  });

  it("offers manual wait/reload/close for unresponsive and ignores recovered dialog results", async () => {
    const s = setup();
    s.recovery.unresponsive(s.window);
    await flush();
    expect(s.showDialog).toHaveBeenCalledWith(s.window, "unresponsive");
    expect(s.reload).not.toHaveBeenCalled();
    s.recovery.responsive(s.window);
    s.choices[0].resolve("close");
    await flush();
    expect(s.close).not.toHaveBeenCalled();
    s.recovery.unresponsive(s.window);
    await flush();
    s.choices[1].resolve("wait");
    await flush();
    expect(s.showDialog).toHaveBeenCalledTimes(2);
    s.recovery.unresponsive(s.window);
    await flush();
    s.choices[2].resolve("reload");
    await flush();
    expect(s.reload).toHaveBeenCalledTimes(1);
    s.fail();
    await flush();
    // Failed explicit retries return to a native choice, without starting an automatic loop.
    expect(s.reload).toHaveBeenCalledTimes(1);
    expect(s.showDialog).toHaveBeenCalledTimes(4);
  });

  it.each(["close", "replace", "shutdown"])("discards pending results after %s", async (action) => {
    const s = setup();
    s.recovery.unresponsive(s.window);
    await flush();
    if (action === "close") s.recovery.closed(s.window);
    if (action === "replace") s.replace();
    if (action === "shutdown") s.recovery.shutdown();
    s.choices[0].resolve("reload");
    await flush();
    s.recovery.utilityReady(2, { restarted: true });
    await flush();
    expect(s.reload).toHaveBeenCalledTimes(action === "replace" ? 1 : 0);
    expect(s.reload.mock.calls.every(([window]) => window !== s.window)).toBe(true);
  });

  it("handles reload rejection and dialog rejection without an automatic loop", async () => {
    const s = setup();
    s.reload.mockRejectedValueOnce(new Error("load failed"));
    s.showDialog.mockRejectedValueOnce(new Error("dialog failed"));
    s.fail();
    await flush();
    expect(s.reload).toHaveBeenCalledTimes(1);
    expect(s.showDialog).toHaveBeenCalledTimes(1);
    expect(s.onError).toHaveBeenCalledTimes(2);
  });

  it("ignores an old load rejection after a confirmed successful navigation", async () => {
    const s = setup();
    let reject!: (reason: Error) => void;
    s.reload.mockReturnValueOnce(new Promise((_resolve, fail) => (reject = fail)));
    s.fail();
    s.recovery.documentLoaded(s.window, "app://app/success");
    reject(new Error("retired navigation"));
    await flush();
    expect(s.showDialog).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RECOVERY_STABLE_MS);
    s.fail();
    await flush();
    expect(s.reload).toHaveBeenCalledTimes(2);
  });

  it("keeps the native failure choice through duplicate starting notifications", async () => {
    const s = setup();
    s.recovery.utilityStarting(2);
    s.recovery.utilityFailed(2);
    await flush();
    s.recovery.utilityStarting(2);
    s.choices[0].resolve("reload");
    await flush();
    expect(s.reload).not.toHaveBeenCalled();
    s.recovery.utilityStarting(3);
    s.recovery.utilityReady(3, { restarted: true });
    await flush();
    expect(s.reload).toHaveBeenCalledTimes(1);
  });

  it("shares one automatic quota across consecutive utility restarts", async () => {
    const s = setup();
    s.recovery.utilityStarting(2);
    s.recovery.utilityReady(2, { restarted: true });
    await flush();
    s.recovery.utilityStarting(3);
    s.recovery.utilityReady(3, { restarted: true });
    s.recovery.utilityReady(3, { restarted: true });
    await flush();
    expect(s.reload).toHaveBeenCalledTimes(1);
    expect(s.showDialog).toHaveBeenCalledTimes(1);
  });

  it("renews the quota after a recovered responsive document is stable", async () => {
    const s = setup();
    s.fail();
    await flush();
    s.recovery.documentLoaded(s.window, "app://app/current");
    await vi.advanceTimersByTimeAsync(20_000);
    s.recovery.unresponsive(s.window);
    await flush();
    s.recovery.responsive(s.window);
    s.choices[0].resolve("reload");
    await flush();
    await vi.advanceTimersByTimeAsync(RECOVERY_STABLE_MS);
    s.fail();
    await flush();
    expect(s.reload).toHaveBeenCalledTimes(2);
  });

  it("preserves the failure dialog across immediate next-generation restart scheduling", async () => {
    const s = setup();
    s.recovery.utilityStarting(1);
    s.recovery.utilityFailed(1);
    s.recovery.utilityStarting(2);
    s.fail();
    await flush();
    expect(s.showDialog).toHaveBeenCalledTimes(1);
    expect(s.reload).not.toHaveBeenCalled();
    s.choices[0].resolve("reload");
    await flush();
    expect(s.reload).not.toHaveBeenCalled();
    s.recovery.utilityReady(2, { restarted: true });
    await flush();
    expect(s.reload).toHaveBeenCalledTimes(1);
  });

  it("waits for the native choice when the replacement becomes ready before the dialog", async () => {
    const s = setup();
    s.recovery.utilityStarting(1);
    s.recovery.utilityFailed(1);
    s.recovery.utilityStarting(2);
    s.recovery.utilityReady(2, { restarted: true });
    await flush();
    expect(s.showDialog).toHaveBeenCalledTimes(1);
    expect(s.reload).not.toHaveBeenCalled();
    s.choices[0].resolve("reload");
    await flush();
    expect(s.reload).toHaveBeenCalledTimes(1);
  });

  it("never automatically reloads through repeated failed utility startups", async () => {
    const s = setup();
    s.recovery.utilityStarting(1);
    for (let generation = 1; generation <= 4; generation++) {
      s.recovery.utilityFailed(generation);
      s.recovery.utilityStarting(generation + 1);
      await flush();
    }
    expect(s.showDialog).toHaveBeenCalledTimes(1);
    expect(s.reload).not.toHaveBeenCalled();
    s.choices[0].resolve("reload");
    await flush();
    // A choice from an older failed generation cannot act on the newer failure.
    expect(s.showDialog).toHaveBeenCalledTimes(2);
    expect(s.reload).not.toHaveBeenCalled();
  });

  it("retries the committed in-page route without treating it as successful document load", async () => {
    const s = setup();
    s.recovery.documentLoaded(s.window, "app://app/start");
    s.recovery.sameDocumentNavigated(s.window, "app://app/route?view=details", true);
    s.recovery.sameDocumentNavigated(s.window, "app://app/subframe", false);
    s.recovery.sameDocumentNavigated(s.window, "https://example.com/", true);
    s.recovery.rendererGone(s.window, "crashed");
    await flush();
    expect(s.reload).toHaveBeenCalledExactlyOnceWith(s.window, "app://app/route?view=details");
    s.recovery.sameDocumentNavigated(s.window, "app://app/another", true);
    await vi.advanceTimersByTimeAsync(RECOVERY_STABLE_MS);
    s.fail();
    await flush();
    expect(s.reload).toHaveBeenCalledTimes(1);
    expect(s.showDialog).toHaveBeenCalledTimes(1);
  });

  it("queues a second failure behind a pending reload without a parallel action", async () => {
    const s = setup();
    const loading = deferred<unknown>();
    s.reload.mockReturnValueOnce(loading.promise);
    s.fail();
    s.fail();
    await flush();
    expect(s.reload).toHaveBeenCalledTimes(1);
    expect(s.showDialog).not.toHaveBeenCalled();
    loading.resolve(undefined);
    await flush();
    expect(s.showDialog).toHaveBeenCalledTimes(1);
  });
});
