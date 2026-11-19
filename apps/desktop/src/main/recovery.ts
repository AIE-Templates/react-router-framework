import { isAppUrl } from "./app-url.ts";

export type RecoveryChoice = "reload" | "close" | "wait" | "dismissed";
export type RecoveryDialog = "failure" | "unresponsive";

interface WindowRecoveryOptions {
  isDestroyed(): boolean;
  /** Load the supplied, validated document URL in the existing window. */
  reload(url: string): void | Promise<unknown>;
  /** Stop an in-flight load before an explicit retry supersedes it. */
  cancelReload(): void;
  close(): void;
  /** The host dismisses the native sheet when its owning fault is retired. */
  showDialog(kind: RecoveryDialog, signal: AbortSignal): Promise<RecoveryChoice>;
  onError?(error: unknown): void;
}

export const RECOVERY_STABLE_MS = 30_000;

/** One coordinator per window, from adoption through close. The host owns the native listeners. */
export function createWindowRecovery(initialUrl: string, options: WindowRecoveryOptions) {
  if (!isAppUrl(initialUrl)) throw new Error("Recovery requires an application document URL");
  interface RecoveryState {
    target: string;
    active: boolean;
    loaded: boolean;
    autoUsed: boolean;
    manualRetry: boolean;
    epoch: number;
    unresponsive: boolean;
    reloadInFlight: boolean;
    reloadGeneration: number;
    dialogController?: AbortController;
    dialog?: RecoveryDialog;
    utilityFailureChoice: boolean;
    pending?: "manual" | "auto";
    stableTimer?: ReturnType<typeof setTimeout>;
  }
  const state: RecoveryState = {
    target: initialUrl,
    active: false,
    loaded: false,
    autoUsed: false,
    manualRetry: false,
    epoch: 0,
    unresponsive: false,
    reloadInFlight: false,
    reloadGeneration: 0,
    utilityFailureChoice: false,
  };
  let stopped = false;
  let utility: { generation: number; state: "starting" | "ready" | "failed" } | undefined;
  let handledGeneration = -1;

  const live = () => !stopped && !options.isDestroyed();
  const cancelStable = () => {
    clearTimeout(state.stableTimer);
    state.stableTimer = undefined;
  };
  const invalidate = () => {
    cancelStable();
    state.epoch++;
    state.dialogController?.abort();
    state.dialogController = undefined;
  };
  const beginFault = () => {
    invalidate();
    state.active = true;
  };
  const endUnresponsive = () => {
    invalidate();
    state.unresponsive = false;
    state.dialog = state.utilityFailureChoice ? "failure" : undefined;
  };
  const report = (error: unknown) => options.onError?.(error);
  const awaitStability = () => {
    if (!state.active || !state.loaded || state.unresponsive) return;
    const epoch = state.epoch;
    state.stableTimer = setTimeout(() => {
      if (!live() || state.epoch !== epoch) return;
      state.active = false;
      state.autoUsed = false;
      state.manualRetry = false;
      state.stableTimer = undefined;
    }, RECOVERY_STABLE_MS);
  };

  const pump = () => {
    if (!live() || state.dialogController) return;
    // A stalled load must not prevent the user from waiting, retrying or closing.
    const urgentDialog = state.dialog === "unresponsive";
    if (state.reloadInFlight && !urgentDialog) return;
    if (state.pending && !urgentDialog) {
      if (utility && utility.state !== "ready") return;
      if (state.unresponsive && state.pending === "auto") return;
      const kind = state.pending;
      state.pending = undefined;
      if (kind === "auto" && (state.autoUsed || state.manualRetry)) {
        state.dialog = "failure";
      } else {
        if (kind === "auto") state.autoUsed = true;
        else state.manualRetry = true;
        state.dialog = undefined;
        state.unresponsive = false;
        state.reloadInFlight = true;
        const reloadGeneration = ++state.reloadGeneration;
        state.loaded = false;
        const epoch = state.epoch;
        let loading: void | Promise<unknown>;
        try {
          loading = options.reload(state.target);
        } catch (error) {
          loading = Promise.reject(error);
        }
        void Promise.resolve(loading)
          .catch((error: unknown) => {
            report(error);
            if (!live() || state.epoch !== epoch || state.reloadGeneration !== reloadGeneration) return;
            beginFault();
            state.dialog = "failure";
          })
          .finally(() => {
            if (state.reloadGeneration !== reloadGeneration) return;
            state.reloadInFlight = false;
            pump();
          });
        return;
      }
    }
    if (!state.dialog) return;
    const kind = state.dialog;
    state.dialog = undefined;
    const controller = new AbortController();
    state.dialogController = controller;
    const epoch = state.epoch;
    void Promise.resolve()
      .then(() => {
        if (live() && state.epoch === epoch) return options.showDialog(kind, controller.signal);
        return undefined;
      })
      .then((choice) => {
        if (!live() || state.epoch !== epoch || (kind === "unresponsive" && !state.unresponsive)) return undefined;
        if (choice === "dismissed") {
          state.dialog = kind;
        } else if (choice === "close") {
          state.pending = undefined;
          state.utilityFailureChoice = false;
          options.close();
        } else if (choice === "reload") {
          state.utilityFailureChoice = false;
          invalidate();
          if (state.reloadInFlight) {
            // Retire the promise before stop() emits events or settles the old load.
            state.reloadGeneration++;
            state.reloadInFlight = false;
            options.cancelReload();
          }
          state.pending = "manual";
        } else if (choice === "wait" && kind === "failure") {
          state.utilityFailureChoice = false;
        }
        return undefined;
      })
      .catch(report)
      .finally(() => {
        if (state.dialogController === controller) state.dialogController = undefined;
        pump();
      });
  };

  const fault = () => {
    if (!live()) return;
    if (state.utilityFailureChoice || state.unresponsive) {
      // A document can fail while its renderer is still hung. Keep the native decision actionable.
      if (state.unresponsive && !state.utilityFailureChoice) state.pending ??= "auto";
      state.loaded = false;
      cancelStable();
      pump();
      return;
    }
    beginFault();
    state.loaded = false;
    if (utility?.state === "starting") {
      state.pending ??= "auto";
      state.dialog = undefined;
    } else if (state.autoUsed || state.manualRetry || utility?.state === "failed") {
      state.dialog = "failure";
    } else {
      state.pending ??= "auto";
    }
    pump();
  };

  return {
    documentLoaded(url: string) {
      if (!live() || !isAppUrl(url)) return;
      invalidate();
      state.target = url;
      state.loaded = true;
      state.utilityFailureChoice = false;
      state.unresponsive = false;
      state.dialog = undefined;
      state.pending = undefined;
      awaitStability();
    },
    /** A committed in-page app navigation changes the retry target, not document health. */
    sameDocumentNavigated(url: string, isMainFrame: boolean) {
      if (!isMainFrame || !live() || !isAppUrl(url)) return;
      state.target = url;
    },
    didFailLoad(details: { errorCode: number; isMainFrame: boolean }) {
      if (details.isMainFrame && details.errorCode !== -3) fault();
    },
    rendererGone(reason: string) {
      if (!live() || reason === "clean-exit") return;
      if (state.unresponsive) endUnresponsive();
      fault();
    },
    unresponsive(this: void) {
      if (!live()) return;
      if (state.unresponsive && state.dialogController) return;
      beginFault();
      state.unresponsive = true;
      state.dialog = "unresponsive";
      pump();
    },
    responsive(this: void) {
      if (!live() || !state.unresponsive) return;
      endUnresponsive();
      awaitStability();
      pump();
    },
    utilityStarting(generation: number) {
      if (stopped || (utility && generation <= utility.generation)) return;
      utility = { generation, state: "starting" };
      if (live()) {
        // A replacement utility does not resolve a hung renderer or a pending startup-failure choice.
        if (state.utilityFailureChoice || state.unresponsive) cancelStable();
        else {
          invalidate();
          // Preserve the recovery need when a generation change retires a native dialog.
          if (state.active && !state.loaded) state.pending ??= "auto";
          state.dialog = undefined;
        }
      }
    },
    utilityReady(generation: number) {
      if (stopped || (utility && generation < utility.generation)) return;
      utility = { generation, state: "ready" };
      if (handledGeneration >= generation || !live()) return;
      handledGeneration = generation;
      if (state.utilityFailureChoice || state.unresponsive) {
        pump();
        return;
      }
      if (state.pending) {
        beginFault();
        pump();
      } else {
        awaitStability();
      }
    },
    utilityFailed(generation: number) {
      if (stopped || (utility && generation < utility.generation)) return;
      utility = { generation, state: "failed" };
      if (!live() || state.loaded || state.unresponsive) return;
      // Reconfirm against the latest failed generation without reopening the same sheet on every backoff.
      if (state.utilityFailureChoice && state.dialogController) state.epoch++;
      else beginFault();
      state.pending = undefined;
      state.utilityFailureChoice = true;
      state.dialog = "failure";
      pump();
    },
    shutdown() {
      stopped = true;
      invalidate();
    },
  };
}
