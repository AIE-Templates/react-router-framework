/** The coordinator never imports Electron; the host owns listeners and native dialogs. */
export interface RecoveryWindow {
  isDestroyed(): boolean;
}

export type RecoveryChoice = "reload" | "close" | "wait";
export type RecoveryDialog = "failure" | "unresponsive";

export interface WindowRecoveryOptions<W extends RecoveryWindow> {
  current(): W | undefined;
  isAppUrl(url: string): boolean;
  /** Load the supplied, validated document URL in the existing window. */
  reload(window: W, url: string): void | Promise<unknown>;
  /** Stop an in-flight load before an explicit retry supersedes it. */
  cancelReload(window: W): void;
  close(window: W): void;
  /** Adapt to dialog.showMessageBox; failure has reload/close, unresponsive adds wait. */
  showDialog(window: W, kind: RecoveryDialog): Promise<RecoveryChoice>;
  onError?(error: unknown): void;
}

export const RECOVERY_STABLE_MS = 30_000;

/**
 * Call track before the initial load; forward main-document did-finish-load with its URL,
 * did-fail-load, render-process-gone, unresponsive/responsive and closed for that same window.
 * Forward did-navigate-in-page to sameDocumentNavigated with its isMainFrame flag.
 * Utility generations must increase monotonically. Starting includes the restart backoff interval
 * (report the upcoming generation there); ready can be reported by both ready and onRestart, with
 * restarted=true for replacement processes. Failure ends the readiness wait with a native choice.
 * Before quit call shutdown. Neither user retry nor this coordinator starts a utility process.
 */
export function createWindowRecovery<W extends RecoveryWindow>(options: WindowRecoveryOptions<W>) {
  interface Episode {
    window: W;
    target: string;
    active: boolean;
    loaded: boolean;
    autoUsed: boolean;
    manualRetry: boolean;
    epoch: number;
    unresponsive: boolean;
    reloadInFlight: boolean;
    reloadGeneration: number;
    dialogInFlight: boolean;
    dialog?: RecoveryDialog;
    utilityFailureChoice: boolean;
    pending?: "manual" | "auto";
    stableTimer?: ReturnType<typeof setTimeout>;
  }
  let episode: Episode | undefined;
  let stopped = false;
  let utility: { generation: number; state: "starting" | "ready" | "failed" } | undefined;
  let handledGeneration = -1;

  const live = (state: Episode) =>
    !stopped && episode === state && !state.window.isDestroyed() && options.current() === state.window;
  const cancelStable = (state: Episode) => {
    clearTimeout(state.stableTimer);
    state.stableTimer = undefined;
  };
  const invalidate = (state: Episode) => {
    cancelStable(state);
    state.epoch++;
  };
  const beginFault = (state: Episode) => {
    invalidate(state);
    state.active = true;
  };
  const report = (error: unknown) => options.onError?.(error);
  const awaitStability = (state: Episode) => {
    if (!state.active || !state.loaded || state.unresponsive) return;
    const epoch = state.epoch;
    state.stableTimer = setTimeout(() => {
      if (!live(state) || state.epoch !== epoch) return;
      state.active = false;
      state.autoUsed = false;
      state.manualRetry = false;
      state.stableTimer = undefined;
    }, RECOVERY_STABLE_MS);
  };

  const pump = (state: Episode) => {
    if (!live(state) || state.dialogInFlight) return;
    // A stalled load must not prevent the user from waiting, retrying or closing.
    const urgentDialog = state.dialog === "unresponsive";
    if (state.reloadInFlight && !urgentDialog) return;
    if (state.pending && !urgentDialog) {
      if (utility && utility.state !== "ready") return;
      const kind = state.pending;
      state.pending = undefined;
      if (kind === "auto" && (state.autoUsed || state.manualRetry)) {
        state.dialog = "failure";
      } else {
        if (kind === "auto") state.autoUsed = true;
        else state.manualRetry = true;
        state.dialog = undefined;
        state.reloadInFlight = true;
        const reloadGeneration = ++state.reloadGeneration;
        state.loaded = false;
        const epoch = state.epoch;
        let loading: void | Promise<unknown>;
        try {
          loading = options.reload(state.window, state.target);
        } catch (error) {
          loading = Promise.reject(error);
        }
        void Promise.resolve(loading)
          .catch((error: unknown) => {
            report(error);
            if (!live(state) || state.epoch !== epoch || state.reloadGeneration !== reloadGeneration) return;
            beginFault(state);
            state.dialog = "failure";
          })
          .finally(() => {
            if (state.reloadGeneration !== reloadGeneration) return;
            state.reloadInFlight = false;
            pump(state);
          });
        return;
      }
    }
    if (!state.dialog) return;
    const kind = state.dialog;
    state.dialog = undefined;
    state.dialogInFlight = true;
    const epoch = state.epoch;
    void Promise.resolve()
      .then(() => {
        if (live(state) && state.epoch === epoch) return options.showDialog(state.window, kind);
        return undefined;
      })
      .then((choice) => {
        if (!live(state) || state.epoch !== epoch || (kind === "unresponsive" && !state.unresponsive)) return undefined;
        if (choice === "close") {
          state.utilityFailureChoice = false;
          options.close(state.window);
        } else if (choice === "reload") {
          state.utilityFailureChoice = false;
          invalidate(state);
          if (state.reloadInFlight) {
            // Retire the promise before stop() emits events or settles the old load.
            state.reloadGeneration++;
            state.reloadInFlight = false;
            options.cancelReload(state.window);
          }
          state.pending = "manual";
        }
        return undefined;
      })
      .catch(report)
      .finally(() => {
        state.dialogInFlight = false;
        pump(state);
      });
  };

  const fault = (window: W) => {
    const state = episode;
    if (!state || state.window !== window || !live(state)) return;
    if (state.utilityFailureChoice) {
      state.loaded = false;
      cancelStable(state);
      pump(state);
      return;
    }
    beginFault(state);
    state.loaded = false;
    if (utility?.state === "starting") {
      state.pending ??= "auto";
      state.dialog = undefined;
    } else if (state.autoUsed || state.manualRetry || utility?.state === "failed") {
      state.dialog = "failure";
    } else {
      state.pending ??= "auto";
    }
    pump(state);
  };

  return {
    track(window: W, initialUrl: string) {
      if (stopped) return;
      if (!options.isAppUrl(initialUrl)) throw new Error("Recovery requires an application document URL");
      if (episode) invalidate(episode);
      episode = {
        window,
        target: initialUrl,
        active: false,
        loaded: false,
        autoUsed: false,
        manualRetry: false,
        epoch: 0,
        unresponsive: false,
        reloadInFlight: false,
        reloadGeneration: 0,
        dialogInFlight: false,
        utilityFailureChoice: false,
      };
    },
    closed(window: W) {
      if (episode?.window !== window) return;
      invalidate(episode);
      episode = undefined;
    },
    documentLoaded(window: W, url: string) {
      const state = episode;
      if (!state || state.window !== window || !live(state) || !options.isAppUrl(url)) return;
      invalidate(state);
      state.target = url;
      state.loaded = true;
      state.utilityFailureChoice = false;
      state.unresponsive = false;
      state.dialog = undefined;
      state.pending = undefined;
      awaitStability(state);
    },
    /** A committed in-page app navigation changes the retry target, not document health. */
    sameDocumentNavigated(window: W, url: string, isMainFrame: boolean) {
      const state = episode;
      if (!isMainFrame || !state || state.window !== window || !live(state) || !options.isAppUrl(url)) return;
      state.target = url;
    },
    didFailLoad(window: W, details: { errorCode: number; isMainFrame: boolean }) {
      if (details.isMainFrame && details.errorCode !== -3) fault(window);
    },
    rendererGone(window: W, reason: string) {
      if (reason !== "clean-exit") fault(window);
    },
    unresponsive(window: W) {
      const state = episode;
      if (!state || state.window !== window || !live(state)) return;
      beginFault(state);
      state.unresponsive = true;
      state.dialog = "unresponsive";
      pump(state);
    },
    responsive(window: W) {
      const state = episode;
      if (!state || state.window !== window || !live(state) || !state.unresponsive) return;
      invalidate(state);
      state.unresponsive = false;
      if (state.dialog === "unresponsive") state.dialog = undefined;
      awaitStability(state);
    },
    utilityStarting(generation: number) {
      if (stopped || (utility && generation <= utility.generation)) return;
      utility = { generation, state: "starting" };
      if (episode && live(episode)) {
        // A failed start still needs its native choice even if server-process immediately
        // schedules another generation. The choice's retry waits for that existing startup.
        if (episode.utilityFailureChoice) cancelStable(episode);
        else {
          invalidate(episode);
          episode.dialog = undefined;
        }
      }
    },
    utilityReady(generation: number, { restarted }: { restarted: boolean }) {
      if (stopped || (utility && generation < utility.generation)) return;
      utility = { generation, state: "ready" };
      const state = episode;
      if (handledGeneration >= generation || !state || !live(state)) return;
      handledGeneration = generation;
      if (state.utilityFailureChoice) {
        pump(state);
        return;
      }
      if (restarted || state.pending) {
        beginFault(state);
        state.pending ??= "auto";
        pump(state);
      }
    },
    utilityFailed(generation: number) {
      if (stopped || (utility && generation < utility.generation)) return;
      utility = { generation, state: "failed" };
      const state = episode;
      if (!state || !live(state)) return;
      beginFault(state);
      state.pending = undefined;
      state.utilityFailureChoice = true;
      state.dialog = "failure";
      pump(state);
    },
    shutdown() {
      stopped = true;
      if (episode) invalidate(episode);
      episode = undefined;
    },
  };
}
