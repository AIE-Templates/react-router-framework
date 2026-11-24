import { visualBootstrapConfig, visualCodec } from "./bootstrap";
import {
  DEFAULT_VISUAL_PREFERENCES,
  type ColorSchemeSnapshot,
  type VisualPreferences,
  type VisualState,
  type VisualStatus,
} from "./types";

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
  externalColorScheme: serverColorScheme,
  applyToDocument = true,
}: {
  initialPreferences?: Readonly<VisualPreferences>;
  host?: Window;
  externalColorScheme?: ColorSchemeSnapshot;
  applyToDocument?: boolean;
} = {}) {
  const config = visualBootstrapConfig;
  const server = freeze(
    visualCodec.resolve(
      visualCodec.parse({
        ...initialPreferences,
        colorScheme: serverColorScheme?.preference ?? initialPreferences.colorScheme,
      }),
    ),
  );
  const bootstrap = host?.frameworkVisualBootstrap;
  const validBootstrap =
    bootstrap?.version === 1 && bootstrap.storageKey === config.storageKey && bootstrap.state?.preferences;
  const fixedAppearance = validBootstrap ? bootstrap.fixedAppearance : undefined;
  let externalColorScheme = serverColorScheme;
  const prepaintColor = validBootstrap && bootstrap.externalColorScheme;
  if (prepaintColor && (!externalColorScheme || prepaintColor.revision >= externalColorScheme.revision))
    externalColorScheme = prepaintColor;
  let writeColorScheme: ((value: VisualPreferences["colorScheme"]) => void) | undefined;
  let failedColorScheme: VisualPreferences["colorScheme"] | undefined;
  const stored = visualCodec.read(config, initialPreferences, host, externalColorScheme, fixedAppearance);
  // The bootstrap is a fallback for inaccessible storage, not a replayable preference authority.
  const initial =
    validBootstrap && stored.persistence === "unavailable"
      ? {
          ...stored,
          state: visualCodec.resolve(
            visualCodec.parse({
              ...bootstrap.state.preferences,
              colorScheme: externalColorScheme?.preference ?? bootstrap.state.preferences.colorScheme,
            }),
            host,
            fixedAppearance,
          ),
        }
      : stored;
  let state = freeze(initial.state);
  let storagePresent = initial.storagePresent;
  const serverStatus: VisualStatus = Object.freeze({ initialized: false, persistence: "unavailable" });
  let status: VisualStatus = { initialized: false, persistence: initial.persistence };
  const listeners = new Set<() => void>();
  const statusListeners = new Set<() => void>();
  const commandListeners = new Set<(command: "update" | "reset") => void>();
  let connections = 0;
  let cleanup: (() => void) | undefined;
  let unsaved = false;
  function setStatus(next: VisualStatus) {
    if (
      next.initialized === status.initialized &&
      next.persistence === status.persistence &&
      next.colorSchemeSaveFailed === status.colorSchemeSaveFailed
    )
      return;
    status = Object.freeze(next);
    for (const notify of statusListeners) notify();
  }
  function publish(preferences: VisualPreferences) {
    const effective = externalColorScheme
      ? { ...preferences, colorScheme: externalColorScheme.preference }
      : preferences;
    const next = freeze(visualCodec.resolve(effective, host, fixedAppearance));
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
      const localPreferences = externalColorScheme
        ? { direction: preferences.direction, reducedMotion: preferences.reducedMotion }
        : preferences;
      host.localStorage.setItem(config.storageKey, JSON.stringify({ version: 1, preferences: localPreferences }));
      unsaved = false;
      storagePresent = true;
      setStatus({ ...status, persistence: "saved" });
    } catch {
      unsaved = true;
      setStatus({ ...status, persistence: "failed" });
    }
  }
  function reportColorSchemeFailure(preference?: VisualPreferences["colorScheme"]) {
    failedColorScheme = preference;
    setStatus({ ...status, colorSchemeSaveFailed: preference !== undefined });
  }
  function requestColorScheme(preference: VisualPreferences["colorScheme"]) {
    if (writeColorScheme) writeColorScheme(preference);
    else reportColorSchemeFailure(preference);
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
    if (!externalColorScheme || reset || patch.direction !== undefined || patch.reducedMotion !== undefined)
      persist(next, reset);
    if (externalColorScheme && (reset || patch.colorScheme !== undefined)) requestColorScheme(next.colorScheme);
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
    storagePresent = next.storagePresent;
    publish(next.state.preferences);
    setStatus({ ...status, persistence: next.persistence });
  }
  const actions = Object.freeze({
    setPreferences: (preferences: VisualPreferences) => update(preferences),
    setColorSchemePreference: (colorScheme: VisualPreferences["colorScheme"]) => update({ colorScheme }),
    setDirection: (direction: VisualPreferences["direction"]) => update({ direction }),
    setReducedMotionPreference: (reducedMotion: VisualPreferences["reducedMotion"]) => update({ reducedMotion }),
    resetColorSchemePreference: () => update({ colorScheme: "auto" }),
    resetDirection: () => update({ direction: "ltr" }),
    resetReducedMotionPreference: () => update({ reducedMotion: "auto" }),
    resetVisualPreferences: () => update({}, true),
    retryColorScheme: () => {
      if (failedColorScheme) requestColorScheme(failedColorScheme);
    },
  });
  return {
    fixedAppearance,
    actions,
    reportColorSchemeFailure,
    hasExternalColorScheme: () => externalColorScheme !== undefined,
    applyExternalColorScheme(snapshot: ColorSchemeSnapshot) {
      if (externalColorScheme && snapshot.revision <= externalColorScheme.revision) return;
      externalColorScheme = snapshot;
      publish(state.preferences);
    },
    bindColorSchemeWriter(writer: (preference: VisualPreferences["colorScheme"]) => void) {
      writeColorScheme = writer;
      return () => {
        if (writeColorScheme === writer) writeColorScheme = undefined;
      };
    },
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
        // Preserve an unpersisted request seed, but never resurrect a record removed while disconnected.
        if (!unsaved) {
          const next = visualCodec.read(config, state.preferences, host);
          const preferences =
            storagePresent && next.storagePresent === false ? DEFAULT_VISUAL_PREFERENCES : next.state.preferences;
          if (next.storagePresent !== undefined) storagePresent = next.storagePresent;
          publish(preferences);
          setStatus({ ...status, initialized: true, persistence: next.persistence });
        } else {
          publish(state.preferences);
          setStatus({ ...status, initialized: true });
        }
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
