import type { ScriptCookies } from "./script-cookies.ts";
import { abandonOn, STORE_TIMEOUT_MS, storeDeadline } from "./store.ts";

interface Snapshot {
  pathname: string;
  dirty: boolean;
  value: string;
  sequence: number;
}

export function createCookieSnapshots(script: ScriptCookies) {
  const entries = new Map<string, Snapshot>();
  let refreshing = false;
  const pending = new Set<string>();

  function touch(url: string, entry: Snapshot) {
    entries.delete(url);
    entries.set(url, entry);
  }

  function needsRefresh(entry: Snapshot) {
    return entry.dirty && !pending.has(entry.pathname);
  }

  function schedule() {
    if (refreshing || !Array.from(entries.values()).some(needsRefresh)) return;
    refreshing = true;
    setImmediate(() => void refresh());
  }

  async function refresh() {
    const deadline = storeDeadline(STORE_TIMEOUT_MS);
    const batch = new Map<string, { url: string; entry: Snapshot; sequence: number }[]>();
    for (const [url, entry] of entries) {
      if (!needsRefresh(entry)) continue;
      entry.dirty = false;
      const group = batch.get(entry.pathname) ?? [];
      group.push({ url, entry, sequence: entry.sequence });
      batch.set(entry.pathname, group);
    }
    try {
      await Promise.all(
        Array.from(batch, async ([pathname, group]) => {
          pending.add(pathname);
          // readText queries only the pathname. Only native settlement releases that key.
          const native = script.readText(group[0].url).finally(() => {
            pending.delete(pathname);
            schedule();
          });
          try {
            const value = await abandonOn(native, deadline.signal);
            for (const { url, entry, sequence } of group) {
              if (entry.sequence === sequence && entries.get(url) === entry) entry.value = value;
            }
          } catch {
            // Keep the last successful snapshot during an outage.
          }
        }),
      );
    } finally {
      deadline.clear();
      refreshing = false;
      schedule();
    }
  }

  return {
    record(url: string, value: string) {
      const entry = entries.get(url) ?? { value, sequence: 0, dirty: false, pathname: new URL(url).pathname };
      entry.sequence++;
      entry.value = value;
      touch(url, entry);
      if (entries.size > 100) {
        const oldest = entries.keys().next().value!;
        entries.delete(oldest);
      }
    },
    fallback(url: string) {
      const entry = entries.get(url);
      if (!entry) return "";
      touch(url, entry);
      return entry.value;
    },
    storageChanged() {
      for (const entry of entries.values()) {
        entry.sequence++;
        entry.dirty = true;
      }
      schedule();
    },
  };
}
