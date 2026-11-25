import type { ScriptCookies } from "./script-cookies.ts";
import { STORE_TIMEOUT_MS, storeDeadline } from "./store.ts";

interface Snapshot {
  value: string;
  sequence: number;
}

export function createCookieSnapshots(script: ScriptCookies) {
  const entries = new Map<string, Snapshot>();
  let refreshing = false;
  let needsRefresh = false;

  function touch(url: string, entry: Snapshot) {
    entries.delete(url);
    entries.set(url, entry);
  }

  async function refresh() {
    // A change during this batch invalidates its reads and requests exactly one more batch.
    do {
      needsRefresh = false;
      const deadline = storeDeadline(STORE_TIMEOUT_MS);
      try {
        await Promise.all(
          Array.from(entries, async ([url, entry]) => {
            const sequence = entry.sequence;
            try {
              const value = await script.readText(url, deadline.signal);
              if (entry.sequence === sequence && entries.get(url) === entry) entry.value = value;
            } catch {
              // Keep the last successful snapshot during an outage.
            }
          }),
        );
      } finally {
        deadline.clear();
      }
    } while (needsRefresh);
    refreshing = false;
  }

  return {
    record(url: string, value: string) {
      const entry = entries.get(url) ?? { value, sequence: 0 };
      entry.sequence++;
      entry.value = value;
      touch(url, entry);
      if (entries.size > 100) entries.delete(entries.keys().next().value!);
    },
    fallback(url: string) {
      const entry = entries.get(url);
      if (!entry) return "";
      touch(url, entry);
      return entry.value;
    },
    storageChanged() {
      if (!entries.size) return;
      for (const entry of entries.values()) entry.sequence++;
      needsRefresh = true;
      if (refreshing) return;
      refreshing = true;
      setImmediate(() => void refresh());
    },
  };
}
