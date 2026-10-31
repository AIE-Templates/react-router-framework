import {
  isDesktopWindowState,
  parseDesktopBootstrap,
  type ChromeMode,
  type WindowChromeBridge,
  type DesktopWindowState,
  type OverlayAppearance,
  type OverlayAppearanceResult,
  type Shell,
} from "@repo/shared";

export interface AppEnvironment {
  shell: Shell;
  fullscreen?: boolean;
  mode: ChromeMode;
  enhancement: "pending" | "available" | "unavailable";
  windowState?: DesktopWindowState;
  diagnostic?: "invalid-bootstrap" | "host-mismatch" | "bridge-failed";
  /** Field names only: safe to expose for diagnosis, without recording host payloads. */
  diagnosticFields?: readonly string[];
}

/** Framework-free document runtime. No DOM reads or bridge calls during construction or SSR. */
export function createWindowChromeRuntime(initial: { shell?: Shell; mode?: ChromeMode; fullscreen?: boolean } = {}) {
  const serverSnapshot: AppEnvironment = {
    shell: initial.shell ?? { kind: "web" },
    fullscreen: initial.fullscreen,
    mode: initial.mode ?? "system-decorated",
    enhancement: "pending",
  };
  let snapshot = serverSnapshot;
  let bridge: WindowChromeBridge | undefined;
  let generation = 0;
  let appearanceRevision = 0;
  let release: (() => void) | undefined;
  const listeners = new Set<() => void>();
  function publish(next: AppEnvironment) {
    snapshot = next;
    for (const listener of listeners) listener();
  }
  function disconnect() {
    generation++;
    bridge = undefined;
    release?.();
    release = undefined;
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
    connect(candidate: WindowChromeBridge | undefined) {
      disconnect();
      const current = generation;
      if (!candidate) {
        publish({ ...snapshot, windowState: undefined, enhancement: "unavailable", diagnostic: undefined });
        return disconnect;
      }
      try {
        const bootstrap = parseDesktopBootstrap(candidate.bootstrap);
        if (
          !bootstrap ||
          typeof candidate.subscribeWindowState !== "function" ||
          typeof candidate.updateOverlayAppearance !== "function"
        ) {
          publish({ ...snapshot, windowState: undefined, enhancement: "unavailable", diagnostic: "invalid-bootstrap" });
          return disconnect;
        }
        bridge = candidate;
        const initialShell = serverSnapshot.shell;
        const diagnosticFields: string[] =
          initialShell.kind === "desktop"
            ? (["platform", "osVersion", "desktopEnv", "sessionType"] as const).filter(
                (key) => initialShell[key] !== bootstrap.shell[key],
              )
            : [];
        if (initialShell.kind === "desktop" && serverSnapshot.mode !== bootstrap.mode) diagnosticFields.push("mode");
        publish({
          ...snapshot,
          shell: bootstrap.shell,
          mode: bootstrap.mode,
          windowState: undefined,
          enhancement: "available",
          diagnostic: diagnosticFields.length ? "host-mismatch" : undefined,
          diagnosticFields: diagnosticFields.length ? diagnosticFields : undefined,
        });
        release = candidate.subscribeWindowState((state) => {
          if (current !== generation || !isDesktopWindowState(state)) return;
          if (snapshot.windowState && state.revision <= snapshot.windowState.revision) return;
          publish({ ...snapshot, windowState: { ...state } });
        });
      } catch {
        disconnect();
        publish({ ...snapshot, enhancement: "unavailable", diagnostic: "bridge-failed" });
      }
      return disconnect;
    },
    async declareOverlayAppearance(
      this: void,
      owner: string,
      appearance: OverlayAppearance | null,
    ): Promise<OverlayAppearanceResult> {
      if (!bridge?.declareOverlayAppearance || snapshot.enhancement !== "available")
        return { status: "unsupported", reason: "appearance-declaration-unavailable" };
      const current = generation;
      try {
        const result = await bridge.declareOverlayAppearance({ owner, revision: ++appearanceRevision, appearance });
        return current === generation ? result : { status: "rejected", reason: "desktop-document-changed" };
      } catch {
        return { status: "rejected", reason: "desktop-bridge-failed" };
      }
    },
    async updateOverlayAppearance(this: void, appearance: OverlayAppearance): Promise<OverlayAppearanceResult> {
      if (!bridge || snapshot.enhancement !== "available")
        return { status: "unsupported", reason: "desktop-bridge-unavailable" };
      const current = generation;
      try {
        const result = await bridge.updateOverlayAppearance(appearance);
        return current === generation ? result : { status: "rejected", reason: "desktop-document-changed" };
      } catch {
        return { status: "rejected", reason: "desktop-bridge-failed" };
      }
    },
  };
}
