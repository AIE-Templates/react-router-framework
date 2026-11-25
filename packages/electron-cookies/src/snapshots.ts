import type { ScriptCookies } from "./script-cookies.ts";
import { abandonOn, STORE_TIMEOUT_MS, storeDeadline } from "./store.ts";

interface Snapshot {
  value: string;
  sequence: number;
}

export function createCookieSnapshots(script: ScriptCookies) {
  const entries = new Map<string, Snapshot>();
  let refreshing = false;
  const dirty = new Set<string>();
  const pending = new Set<string>();

  function touch(url: string, entry: Snapshot) {
    entries.delete(url);
    entries.set(url, entry);
  }

  function schedule() {
    if (refreshing || !Array.from(dirty).some((url) => !pending.has(url))) return;
    refreshing = true;
    setImmediate(() => void refresh());
  }

  async function refresh() {
    const deadline = storeDeadline(STORE_TIMEOUT_MS);
    const batch = Array.from(dirty).filter((url) => !pending.has(url));
    try {
      await Promise.all(
        batch.map(async (url) => {
          dirty.delete(url);
          const entry = entries.get(url);
          if (!entry) return;
          const sequence = entry.sequence;
          pending.add(url);
          // The deadline abandons this batch. Only native settlement releases the URL.
          const native = script.readText(url).finally(() => {
            pending.delete(url);
            schedule();
          });
          try {
            const value = await abandonOn(native, deadline.signal);
            if (entry.sequence === sequence && entries.get(url) === entry) entry.value = value;
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
      const entry = entries.get(url) ?? { value, sequence: 0 };
      entry.sequence++;
      entry.value = value;
      touch(url, entry);
      if (entries.size > 100) {
        const oldest = entries.keys().next().value!;
        entries.delete(oldest);
        dirty.delete(oldest);
      }
    },
    fallback(url: string) {
      const entry = entries.get(url);
      if (!entry) return "";
      touch(url, entry);
      return entry.value;
    },
    storageChanged() {
      for (const [url, entry] of entries) {
        entry.sequence++;
        dirty.add(url);
      }
      schedule();
    },
  };
}
