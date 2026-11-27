import {
  isDesktopWindowState,
  parseDesktopBootstrap,
  supportsOverlayAppearance,
  type ChromeMode,
  type WindowChromeBridge,
  type DesktopWindowState,
  type OverlayAppearance,
  type OverlayAppearanceResult,
  type Shell,
} from "@repo/shared";

export interface ChromeState {
  /** Effective native fullscreen, seeded for hydration and cleared when disconnected. */
  readonly fullscreen?: boolean;
  readonly mode: ChromeMode;
  readonly enhancement: "pending" | "available" | "unavailable";
  readonly canSetOverlayAppearance: boolean;
  readonly windowState?: Readonly<DesktopWindowState>;
  readonly diagnostic?: "invalid-bootstrap" | "host-mismatch" | "bridge-failed";
  /** Field names only: safe to expose for diagnosis, without recording host payloads. */
  readonly diagnosticFields?: readonly string[];
}

export interface ChromeAdapterSnapshot {
  readonly shell: Shell;
  readonly chrome: ChromeState;
}

export interface ChromeSeed {
  shell?: Shell;
  mode?: ChromeMode;
  fullscreen?: boolean;
}

// Recreated runtimes share the document bridge and must not restart its native sequence.
const appearanceRevisions = new WeakMap<WindowChromeBridge, number>();

async function sendDeclaration(
  target: WindowChromeBridge,
  owner: string,
  appearance: OverlayAppearance | null,
): Promise<OverlayAppearanceResult> {
  try {
    const revision = (appearanceRevisions.get(target) ?? 0) + 1;
    appearanceRevisions.set(target, revision);
    return await target.declareOverlayAppearance({ owner, revision, appearance });
  } catch {
    return { status: "rejected", reason: "desktop-bridge-failed" };
  }
}

/** Framework-free document runtime. No DOM reads or bridge calls during construction or SSR. */
export function createChromeAdapter(initial: ChromeSeed = {}) {
  const serverSnapshot: ChromeAdapterSnapshot = {
    shell: initial.shell ?? { kind: "web" },
    chrome: {
      fullscreen: initial.fullscreen,
      mode: initial.mode ?? "system-decorated",
      enhancement: "pending",
      canSetOverlayAppearance: false,
    },
  };
  let snapshot = serverSnapshot;
  let bridge: WindowChromeBridge | undefined;
  let generation = 0;
  let release: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const appearanceOwners = new Set<string>();
  function publish(change: Partial<Omit<ChromeState, "canSetOverlayAppearance">>, shell = snapshot.shell) {
    const chrome = { ...snapshot.chrome, ...change };
    chrome.canSetOverlayAppearance =
      chrome.enhancement === "available" &&
      shell.kind === "desktop" &&
      supportsOverlayAppearance(shell.platform, chrome.mode);
    snapshot = { shell, chrome };
    for (const listener of listeners) listener();
  }
  function disconnect() {
    generation++;
    const previous = bridge;
    bridge = undefined;
    // Parent effect cleanup can run before AppShell cleanup. Release ownership while the bridge exists.
    if (previous) {
      for (const owner of appearanceOwners) void sendDeclaration(previous, owner, null);
    }
    appearanceOwners.clear();
    const unsubscribe = release;
    release = undefined;
    let diagnostic = snapshot.chrome.diagnostic;
    try {
      unsubscribe?.();
    } catch {
      diagnostic = "bridge-failed";
    }
    if (snapshot.chrome.enhancement === "available") {
      publish({
        windowState: undefined,
        enhancement: "unavailable",
        fullscreen: undefined,
        diagnostic,
      });
    }
  }
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => serverSnapshot,
    subscribe(this: void, listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Use one stable bridge reference per document, including across adapter remounts. */
    connect(candidate: WindowChromeBridge | undefined) {
      disconnect();
      const current = generation;
      const stop = () => {
        if (current === generation) disconnect();
      };
      if (!candidate) {
        publish({
          windowState: undefined,
          enhancement: "unavailable",
          fullscreen: undefined,
          diagnostic: undefined,
        });
        return stop;
      }
      try {
        const bootstrap = parseDesktopBootstrap(candidate.bootstrap);
        if (
          !bootstrap ||
          typeof candidate.subscribeWindowState !== "function" ||
          typeof candidate.declareOverlayAppearance !== "function"
        ) {
          publish({
            windowState: undefined,
            enhancement: "unavailable",
            fullscreen: undefined,
            diagnostic: "invalid-bootstrap",
          });
          return stop;
        }
        bridge = candidate;
        const initialShell = serverSnapshot.shell;
        const diagnosticFields: string[] =
          initialShell.kind === "desktop"
            ? (["platform", "osVersion", "desktopEnv", "sessionType"] as const).filter(
                (key) => initialShell[key] !== bootstrap.shell[key],
              )
            : [];
        if (initialShell.kind === "desktop" && serverSnapshot.chrome.mode !== bootstrap.mode)
          diagnosticFields.push("mode");
        publish(
          {
            mode: bootstrap.mode,
            windowState: undefined,
            enhancement: "available",
            diagnostic: diagnosticFields.length ? "host-mismatch" : undefined,
            diagnosticFields: diagnosticFields.length ? diagnosticFields : undefined,
          },
          bootstrap.shell,
        );
        release = candidate.subscribeWindowState((state) => {
          if (current !== generation || !isDesktopWindowState(state)) return;
          if (snapshot.chrome.windowState && state.revision <= snapshot.chrome.windowState.revision) return;
          publish({ windowState: { ...state }, fullscreen: state.fullscreen });
        });
      } catch {
        disconnect();
        publish({
          enhancement: "unavailable",
          fullscreen: undefined,
          diagnostic: "bridge-failed",
        });
      }
      return stop;
    },
    async declareOverlayAppearance(
      this: void,
      owner: string,
      appearance: OverlayAppearance | null,
    ): Promise<OverlayAppearanceResult> {
      if (!bridge?.declareOverlayAppearance || snapshot.chrome.enhancement !== "available")
        return { status: "unsupported", reason: "appearance-declaration-unavailable" };
      const current = generation;
      if (appearance === null) appearanceOwners.delete(owner);
      else appearanceOwners.add(owner);
      const result = await sendDeclaration(bridge, owner, appearance);
      return current === generation ? result : { status: "rejected", reason: "desktop-document-changed" };
    },
  };
}

export type ChromeAdapter = ReturnType<typeof createChromeAdapter>;
