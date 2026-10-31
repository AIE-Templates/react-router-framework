import { visualBootstrapConfig, visualCodec } from "./bootstrap";
import { DEFAULT_VISUAL_PREFERENCES, type VisualPreferences, type VisualState, type VisualStatus } from "./types";

function freeze(value: VisualState): VisualState {
  return Object.freeze({
    preferences: Object.freeze({ ...value.preferences }),
    resolved: Object.freeze({ ...value.resolved }),
  });
}

export type VisualManager = ReturnType<typeof createVisualManager>;
export function createVisualManager({
  initialPreferences = DEFAULT_VISUAL_PREFERENCES,
  host,
  applyToDocument = true,
}: {
  initialPreferences?: Readonly<VisualPreferences>;
  host?: Window;
  applyToDocument?: boolean;
} = {}) {
  const config = visualBootstrapConfig;
  const server = freeze(visualCodec.resolve(visualCodec.parse(initialPreferences)));
  const bootstrap = host?.frameworkVisualBootstrap;
  const validBootstrap =
    bootstrap?.version === 1 && bootstrap.storageKey === config.storageKey && bootstrap.state?.preferences;
  const stored = visualCodec.read(config, initialPreferences, host);
  // The bootstrap is a fallback for inaccessible storage, not a replayable preference authority.
  const initial =
    validBootstrap && stored.persistence === "unavailable"
      ? { ...stored, state: visualCodec.resolve(visualCodec.parse(bootstrap.state.preferences), host) }
      : stored;
  let state = freeze(initial.state);
  const serverStatus: VisualStatus = Object.freeze({ initialized: false, persistence: "unavailable" });
  let status: VisualStatus = { initialized: false, persistence: initial.persistence };
  const listeners = new Set<() => void>();
  const statusListeners = new Set<() => void>();
  const commandListeners = new Set<(command: "update" | "reset") => void>();
  let connections = 0;
  let cleanup: (() => void) | undefined;
  let unsaved = false;
  function setStatus(next: VisualStatus) {
    if (next.initialized === status.initialized && next.persistence === status.persistence) return;
    status = Object.freeze(next);
    for (const notify of statusListeners) notify();
  }
  function publish(preferences: VisualPreferences) {
    const next = freeze(visualCodec.resolve(preferences, host));
    if (JSON.stringify(state) !== JSON.stringify(next)) {
      state = next;
      if (connections && host && applyToDocument) visualCodec.apply(config, state, host.document.documentElement);
      for (const notify of listeners) notify();
    }
  }
  function persist(preferences: VisualPreferences, reset = false) {
    if (!host) return;
    try {
      if (!reset && visualCodec.decode(host.localStorage.getItem(config.storageKey)).kind === "unsupported-version") {
        setStatus({ ...status, persistence: "unsupported-version" });
        unsaved = true;
        return;
      }
      host.localStorage.setItem(config.storageKey, JSON.stringify({ version: 1, preferences }));
      unsaved = false;
      setStatus({ ...status, persistence: "saved" });
    } catch {
      unsaved = true;
      setStatus({ ...status, persistence: "failed" });
    }
  }
  function update(patch: Partial<VisualPreferences>, reset = false) {
    let base = state.preferences;
    if (host && !unsaved && !reset) {
      try {
        const current = visualCodec.decode(host.localStorage.getItem(config.storageKey));
        if (current.kind === "valid") base = current.preferences;
      } catch {
        /* Keep the current session usable. */
      }
    }
    const next = visualCodec.parse(reset ? DEFAULT_VISUAL_PREFERENCES : { ...base, ...patch });
    // Persist even when the value is unchanged: a repeated command retries a failed save.
    persist(next, reset);
    publish(next);
    for (const notify of commandListeners) notify(reset ? "reset" : "update");
  }
  function refreshStorage() {
    if (!host) return;
    const next = visualCodec.read(config, DEFAULT_VISUAL_PREFERENCES, host);
    if (next.persistence === "unavailable") {
      setStatus({ ...status, persistence: "unavailable" });
      return;
    }
    unsaved = false;
    publish(next.state.preferences);
    setStatus({ ...status, persistence: next.persistence });
  }
  const actions = Object.freeze({
    setColorSchemePreference: (colorScheme: VisualPreferences["colorScheme"]) => update({ colorScheme }),
    setDirection: (direction: VisualPreferences["direction"]) => update({ direction }),
    setReducedMotionPreference: (reducedMotion: VisualPreferences["reducedMotion"]) => update({ reducedMotion }),
    resetColorSchemePreference: () => update({ colorScheme: "auto" }),
    resetDirection: () => update({ direction: "ltr" }),
    resetReducedMotionPreference: () => update({ reducedMotion: "auto" }),
    resetVisualPreferences: () => update({}, true),
  });
  return {
    actions,
    subscribeCommands(this: void, listener: (command: "update" | "reset") => void) {
      commandListeners.add(listener);
      return () => {
        commandListeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    getServerSnapshot: () => server,
    getStatus: () => status,
    getServerStatus: () => serverStatus,
    subscribe(this: void, listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeStatus(this: void, listener: () => void) {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    connect() {
      if (!host) return () => {};
      connections++;
      if (connections === 1) {
        // Reconcile reads without overwriting failed in-memory commands or a missing cookie seed.
        if (!unsaved) {
          const next = visualCodec.read(config, state.preferences, host);
          publish(next.state.preferences);
          setStatus({ initialized: true, persistence: next.persistence });
        } else setStatus({ ...status, initialized: true });
        if (applyToDocument) visualCodec.apply(config, state, host.document.documentElement);
        const onStorage = (event: StorageEvent) => {
          try {
            if (event.storageArea && event.storageArea !== host.localStorage) return;
          } catch {
            return;
          }
          if (event.key === config.storageKey || event.key === null) refreshStorage();
        };
        host.addEventListener("storage", onStorage);
        const onSystem = () => publish(state.preferences);
        const media = ["(prefers-color-scheme: dark)", "(prefers-reduced-motion: reduce)"].flatMap((query) => {
          try {
            const value = host.matchMedia?.(query);
            return value ? [value] : [];
          } catch {
            return [];
          }
        });
        for (const query of media) query.addEventListener("change", onSystem);
        cleanup = () => {
          host.removeEventListener("storage", onStorage);
          for (const query of media) query.removeEventListener("change", onSystem);
        };
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--connections === 0) {
          cleanup?.();
          cleanup = undefined;
        }
      };
    },
  };
}
