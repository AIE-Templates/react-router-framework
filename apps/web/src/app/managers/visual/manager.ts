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
function validatedSeed(seed?: VisualRecord) {
  return seed && records.decode(JSON.stringify(seed)).record;
}
type RepairMode = "start" | "runtime" | "ack";
function needsRepair(current: VisualRecord | undefined, target: VisualRecord, mode: RepairMode) {
  if (!current) return true;
  const order = records.compare(current, target);
  return mode === "start" ? order !== 0 : order < 0;
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
}: {
  initialRecord?: VisualRecord;
  initialShell?: Shell["kind"];
  host?: Window;
  nativeSource?: NativeVisualSource;
  config?: typeof visualBootstrapConfig;
} = {}) {
  const server = freeze(visualCodec.resolve(initialRecord));
  const handoff = host?.[config.bootstrapKey];
  const bootstrap = handoff?.storageKey === config.storageKey ? handoff : undefined;
  let fixedAppearance = bootstrap?.fixedAppearance;
  let publishedAppearance = fixedAppearance;
  let record = validatedSeed(bootstrap?.record);
  let highestObserved = records.pick([validatedSeed(initialRecord), record]);
  let state = bootstrap ? freeze(bootstrap.state) : server;
  const storage: Record<keyof VisualStatus["storage"], StoreStatus> = {
    local: "ok",
    cookie: config.cookieName ? "ok" : "absent",
    native: "absent",
  };
  let initialized = false;
  let startPending = true;
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
    if (fixedAppearance !== publishedAppearance || JSON.stringify(next) !== JSON.stringify(state)) {
      publishedAppearance = fixedAppearance;
      state = freeze(next);
      if (connections && host) visualCodec.apply(config, state, host.document.documentElement);
      changes.notify();
    }
    publishStatus();
  }
  function connectNative() {
    latestPush = undefined;
    if (!host) return;
    try {
      native = nativeSource?.connect(host);
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
  function decodeObserved(raw: string | null) {
    const decoded = records.decode(raw);
    if (decoded.record && (!highestObserved || decoded.record.stamp.t > highestObserved.stamp.t)) {
      highestObserved = decoded.record;
    }
    return decoded;
  }
  function readWeb(store: "local" | "cookie") {
    try {
      const raw =
        store === "local"
          ? host!.localStorage.getItem(config.storageKey)
          : readVisualCookie(host!.document.cookie, config.cookieName!);
      return decodeObserved(raw);
    } catch {
      storage[store] = "unavailable";
      return undefined;
    }
  }
  function readNative() {
    if (!native || storage.native === "unavailable") return undefined;
    try {
      const mirror = native.read();
      fixedAppearance = mirror.fixedAppearance;
      const observed = decodeObserved(mirror.record).record;
      if (latestPush && observed) {
        const order = records.compare(observed, latestPush.record);
        if (order > 0 || (order === 0 && !mirror.pending)) latestPush = undefined;
      }
      storage.native = mirror.pending ? "failed" : "ok";
      return observed;
    } catch {
      latestPush = undefined;
      storage.native = "unavailable";
      return undefined;
    }
  }
  function adopt(...observed: (VisualRecord | undefined)[]) {
    record = records.pick([record, ...observed]);
    if (latestPush && record && records.behind(latestPush.record, record)) latestPush = undefined;
  }
  function observe(start = false) {
    const mirror = readNative();
    const cookie = available("cookie") ? readWeb("cookie")?.record : undefined;
    const local = available("local") ? readWeb("local")?.record : undefined;
    const observed = { native: mirror, cookie, local };
    if (start) record = records.atStart(observed);
    else adopt(mirror, cookie, local);
    return observed;
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
  function writeCookie(target: VisualRecord, mode: RepairMode = "runtime") {
    try {
      writeVisualCookie(host!, records.encode(target), config.cookieName);
    } catch {
      /* Judge the write by the observable cookie below. */
    }
    const result = readWeb("cookie");
    if (!result || result.kind === "missing") storage.cookie = "unavailable";
    else {
      storage.cookie = needsRepair(result.record, target, mode) ? "failed" : "ok";
      if (mode === "runtime") adopt(result.record);
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
    latestPush = undefined;
    storage.native = result;
    if (result === "ok") {
      const mirror = readNative();
      const newer = mirror && records.behind(record, mirror);
      if (newer) {
        record = mirror;
        repairWeb("cookie", "ack");
        repairWeb("local", "ack");
      }
      if (newer || fixedAppearance !== publishedAppearance) {
        publish();
        return;
      }
    }
    publishStatus();
  }
  function available(store: keyof typeof storage) {
    return storage[store] !== "absent" && storage[store] !== "unavailable";
  }
  function repairWeb(store: "local" | "cookie", mode: RepairMode, observed?: VisualRecord) {
    const target = record;
    if (!target || !available(store)) return;
    if (!needsRepair(observed, target, mode)) {
      storage[store] = "ok";
      return;
    }
    // Another tab can update this replica between selection and repair.
    const current = readWeb(store);
    if (!current) return;
    if (!needsRepair(current.record, target, mode)) {
      if (mode === "runtime") adopt(current.record);
      storage[store] = "ok";
      return;
    }
    if (store === "local") writeLocal(records.encode(target));
    else writeCookie(target, mode);
  }
  function reconcile(trigger: "start" | "connect" | "event" | "restore" | "retry") {
    const start = trigger === "start";
    if (trigger !== "event") {
      if (storage.local === "unavailable") storage.local = "ok";
      if (storage.cookie === "unavailable") storage.cookie = "ok";
      if (start || trigger === "connect" || storage.native === "unavailable") connectNative();
    }
    const observed = observe(start);
    const mode = start ? "start" : "runtime";
    let beforeRepair: VisualRecord | undefined;
    // A later store can reveal a newer winner after an earlier store was checked.
    do {
      beforeRepair = record;
      repairWeb("cookie", mode, observed.cookie);
      repairWeb("local", mode, observed.local);
    } while (record !== beforeRepair);
    if (
      record &&
      available("native") &&
      (trigger === "retry" || !latestPush || records.compare(latestPush.record, record) !== 0) &&
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
    record = {
      version: 1,
      stamp: records.nextStamp([record, highestObserved]),
      preferences: change({ ...record?.preferences }),
    };
    startPending = false;
    const committed = record;
    if (available("native")) void push(committed);
    if (available("cookie")) writeCookie(committed);
    // Cookie verification can observe a concurrent commit after the first native push.
    if (record !== committed && available("native")) void push(record);
    if (available("local")) writeLocal(records.encode(record));
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
    retry: () => {
      if (initialized) reconcile("retry");
    },
  });
  function attach(window: Window) {
    const trigger = startPending ? "start" : "connect";
    startPending = false;
    initialized = true;
    reconcile(trigger);
    visualCodec.apply(config, state, window.document.documentElement);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== config.storageKey && event.key !== null) return;
      try {
        if (event.storageArea !== window.localStorage) return;
      } catch {
        // The event payload has no verifiable source. Re-read the accessible replicas.
        reconcile("event");
        return;
      }
      if (event.key === config.storageKey) adopt(decodeObserved(event.newValue).record);
      reconcile("event");
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) reconcile("restore");
    };
    const onVisibility = () => {
      if (window.document.visibilityState === "visible") reconcile("restore");
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("pageshow", onPageShow);
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
      window.removeEventListener("pageshow", onPageShow);
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
