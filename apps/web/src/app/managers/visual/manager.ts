import { visualRecordKernel as records, type Shell, type VisualPreferences, type VisualRecord } from "@repo/shared";

import { visualBootstrapConfig, visualCodec } from "./bootstrap";
import { readVisualCookie, writeVisualCookie } from "./cookie";
import type { NativeVisualSource, StoreStatus, VisualState, VisualStatus } from "./types";

function freeze(value: VisualState): VisualState {
  return Object.freeze({
    preferences: Object.freeze({ ...value.preferences }),
    resolved: Object.freeze({ ...value.resolved }),
  });
}
function subscriptions() {
  const listeners = new Set<() => void>();
  return {
    subscribe(this: void, listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify() {
      for (const listener of listeners) listener();
    },
  };
}

export type VisualManager = ReturnType<typeof createVisualManager>;
export function createVisualManager({
  initialRecord,
  initialShell = "web",
  host,
  nativeSource,
  config = visualBootstrapConfig,
  applyToDocument = true,
}: {
  initialRecord?: VisualRecord;
  initialShell?: Shell["kind"];
  host?: Window;
  nativeSource?: NativeVisualSource;
  config?: typeof visualBootstrapConfig;
  applyToDocument?: boolean;
} = {}) {
  const server = freeze(visualCodec.resolve(initialRecord));
  const handoff = host?.[config.bootstrapKey];
  const bootstrap = handoff?.storageKey === config.storageKey ? handoff : undefined;
  let fixedAppearance = bootstrap?.fixedAppearance;
  let record = bootstrap?.record;
  let state = bootstrap ? freeze(bootstrap.state) : server;
  const storage: Record<keyof VisualStatus["storage"], StoreStatus> = {
    local: "ok",
    cookie: config.cookieName ? "ok" : "absent",
    native: "absent",
  };
  let initialized = false;
  const serverStatus: VisualStatus = Object.freeze({ initialized, storage: Object.freeze({ ...storage }) });
  let status = serverStatus;
  const changes = subscriptions();
  const statusChanges = subscriptions();
  let connections = 0;
  let cleanup: (() => void) | undefined;
  let native: ReturnType<NativeVisualSource["connect"]>;
  let latestPush: { record: VisualRecord } | undefined;

  function publishStatus() {
    if (
      status.initialized === initialized &&
      status.storage.local === storage.local &&
      status.storage.cookie === storage.cookie &&
      status.storage.native === storage.native
    )
      return;
    status = Object.freeze({ initialized, storage: Object.freeze({ ...storage }) });
    statusChanges.notify();
  }
  function publish() {
    const next = visualCodec.resolve(record, host, fixedAppearance);
    if (JSON.stringify(next) !== JSON.stringify(state)) {
      state = freeze(next);
      if (connections && host && applyToDocument) visualCodec.apply(config, state, host.document.documentElement);
      changes.notify();
    }
    publishStatus();
  }
  function connectNative() {
    if (!host) return;
    try {
      native = nativeSource?.connect(host);
      if (native && !bootstrap) {
        try {
          fixedAppearance = nativeSource?.prepaint(host)?.fixedAppearance;
        } catch {
          /* The live mirror is independent of its document-start snapshot. */
        }
      }
      storage.native = native
        ? "ok"
        : initialShell === "desktop" || host.desktop !== undefined
          ? "unavailable"
          : "absent";
    } catch {
      native = undefined;
      storage.native = "unavailable";
    }
  }
  function readWeb(store: "local" | "cookie") {
    try {
      const raw =
        store === "local"
          ? host!.localStorage.getItem(config.storageKey)
          : readVisualCookie(host!.document.cookie, config.cookieName!);
      return records.decode(raw);
    } catch {
      storage[store] = "unavailable";
      return undefined;
    }
  }
  function readNative() {
    if (!native || storage.native === "unavailable") return undefined;
    try {
      const mirror = native.read();
      storage.native = mirror.pending ? "failed" : "ok";
      return records.decode(mirror.record).record;
    } catch {
      storage.native = "unavailable";
      return undefined;
    }
  }
  function adopt(...observed: (VisualRecord | undefined)[]) {
    record = records.pick([record, ...observed]);
    if (latestPush && record && records.behind(latestPush.record, record)) latestPush = undefined;
  }
  function observe() {
    const local = storage.local === "unavailable" ? undefined : readWeb("local")?.record;
    const cookie = !config.cookieName || storage.cookie === "unavailable" ? undefined : readWeb("cookie")?.record;
    const mirror = readNative();
    adopt(local, cookie, mirror);
    return { local, cookie, native: mirror };
  }
  function writeLocal(raw: string) {
    let target: Storage;
    try {
      target = host!.localStorage;
    } catch {
      storage.local = "unavailable";
      return;
    }
    try {
      target.setItem(config.storageKey, raw);
      storage.local = "ok";
    } catch {
      storage.local = "failed";
    }
  }
  function writeCookie(target: VisualRecord, raw: string) {
    try {
      writeVisualCookie(host!, raw, config.cookieName);
    } catch {
      /* Judge the write by the observable cookie below. */
    }
    const result = readWeb("cookie");
    if (!result || result.kind === "missing") storage.cookie = "unavailable";
    else {
      storage.cookie = records.behind(result.record, target) ? "failed" : "ok";
      adopt(result.record);
    }
  }
  async function push(target: VisualRecord) {
    if (!native) return;
    const operation = { record: target };
    latestPush = operation;
    let result: StoreStatus;
    try {
      result = await native.push(records.encode(target));
    } catch {
      result = "unavailable";
    }
    if (latestPush !== operation) return;
    storage.native = result;
    publishStatus();
  }
  function available(store: keyof typeof storage) {
    return storage[store] !== "absent" && storage[store] !== "unavailable";
  }
  function repairWeb(store: "local" | "cookie", observed: VisualRecord | undefined, skipWrite: boolean) {
    const target = record;
    if (!target || !available(store)) return;
    if (!records.behind(observed, target)) {
      storage[store] = "ok";
      return;
    }
    if (skipWrite) return;

    // Another tab can update this replica between selection and repair.
    const current = readWeb(store);
    if (!current) return;
    if (!records.behind(current.record, target)) {
      adopt(current.record);
      storage[store] = "ok";
      return;
    }
    const raw = records.encode(target);
    if (store === "local") writeLocal(raw);
    else writeCookie(target, raw);
  }
  function reconcile(trigger: "connect" | "event" | "restore" | "retry") {
    const previous = { ...storage };
    if (trigger !== "event") {
      if (storage.local === "unavailable") storage.local = "ok";
      if (storage.cookie === "unavailable") storage.cookie = "ok";
      if (trigger === "connect" || storage.native === "unavailable") connectNative();
    }
    const observed = observe();
    for (const store of ["local", "cookie"] as const) {
      repairWeb(store, observed[store], trigger === "retry" && previous[store] === "ok");
    }
    if (
      record &&
      available("native") &&
      (records.behind(observed.native, record) || (trigger === "retry" && storage.native === "failed"))
    ) {
      void push(record);
    }
    publish();
  }
  function commit(change: (preferences: Partial<VisualPreferences>) => Partial<VisualPreferences>) {
    // A child effect can issue a command before the provider's connection effect.
    if (!initialized) connectNative();
    observe();
    latestPush = undefined;
    record = { version: 1, stamp: records.nextStamp([record]), preferences: change({ ...record?.preferences }) };
    const raw = records.encode(record);
    if (available("local")) writeLocal(raw);
    if (available("cookie")) writeCookie(record, raw);
    if (available("native")) void push(record);
    publish();
  }
  function reset(field: keyof VisualPreferences) {
    commit((preferences) => {
      delete preferences[field];
      return preferences;
    });
  }
  const actions = Object.freeze({
    setColorSchemePreference: (colorScheme: VisualPreferences["colorScheme"]) =>
      commit((base) => ({ ...base, colorScheme })),
    setDirection: (direction: VisualPreferences["direction"]) => commit((base) => ({ ...base, direction })),
    setReducedMotionPreference: (reducedMotion: VisualPreferences["reducedMotion"]) =>
      commit((base) => ({ ...base, reducedMotion })),
    resetColorSchemePreference: () => reset("colorScheme"),
    resetDirection: () => reset("direction"),
    resetReducedMotionPreference: () => reset("reducedMotion"),
    resetVisualPreferences: () => commit(() => ({})),
    retry: () => reconcile("retry"),
  });
  function attach(window: Window) {
    initialized = true;
    reconcile("connect");
    if (applyToDocument) visualCodec.apply(config, state, window.document.documentElement);
    const onStorage = (event: StorageEvent) => {
      if (event.key === config.storageKey || event.key === null) reconcile("event");
    };
    const onRestore = () => reconcile("restore");
    const onVisibility = () => {
      if (window.document.visibilityState === "visible") onRestore();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("pageshow", onRestore);
    window.document.addEventListener("visibilitychange", onVisibility);
    const media = ["(prefers-color-scheme: dark)", "(prefers-reduced-motion: reduce)"].flatMap((query) => {
      try {
        return window.matchMedia?.(query) ?? [];
      } catch {
        return [];
      }
    });
    for (const query of media) query.addEventListener("change", publish);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pageshow", onRestore);
      window.document.removeEventListener("visibilitychange", onVisibility);
      for (const query of media) query.removeEventListener("change", publish);
      latestPush = undefined;
    };
  }
  return {
    get fixedAppearance() {
      return fixedAppearance;
    },
    prepaint: nativeSource?.prepaint,
    actions,
    getSnapshot: () => state,
    getServerSnapshot: () => server,
    getStatus: () => status,
    getServerStatus: () => serverStatus,
    subscribe: changes.subscribe,
    subscribeStatus: statusChanges.subscribe,
    connect() {
      if (!host) return () => {};
      if (++connections === 1) cleanup = attach(host);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--connections === 0) cleanup?.();
      };
    },
  };
}
