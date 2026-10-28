/**
 * The packages' `stats()` counters, reduced to the measure window. A snapshot is taken when
 * measurement starts and again when it ends; counters are reported as the difference, gauges
 * (values that describe "now", not "how many so far") as their value at the end.
 */
export interface StatsTree {
  [key: string]: number | StatsTree;
}

/** Counters whose value is a level, not a running total: reported as is at the end of the window. */
const GAUGES = new Set(["heldBytes", "heldFrames", "queuedBytes", "peakQueuedBytes", "activeRequests"]);

/** The numeric part of a `stats()` snapshot (nested records kept); `undefined` for anything else. */
export function toStatsTree(value: unknown): StatsTree | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const tree: StatsTree = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number") tree[key] = entry;
    else {
      const nested = toStatsTree(entry);
      if (nested) tree[key] = nested;
    }
  }
  return tree;
}

/** `after - before` per counter, gauges taken from `after`; a missing `before` means from zero. */
export function diffStats(before: StatsTree | undefined, after: StatsTree): StatsTree {
  const out: StatsTree = {};
  for (const [key, value] of Object.entries(after)) {
    const prior = before?.[key];
    if (typeof value === "number") {
      const delta = GAUGES.has(key) || typeof prior !== "number" ? value : value - prior;
      out[key] = Math.round(delta * 1000) / 1000;
    } else {
      out[key] = diffStats(typeof prior === "object" ? prior : undefined, value);
    }
  }
  return out;
}

/** A `stats()` reader that remembers the snapshot at `start()` and reports the window at `stop()`. */
export function statsWindow(read: () => StatsTree | undefined): { start(): void; stop(): StatsTree | undefined } {
  let before: StatsTree | undefined;
  return {
    start() {
      before = read();
    },
    stop() {
      const after = read();
      return after && diffStats(before, after);
    },
  };
}

/** `{ a: { b: 1 } }` → `{ "a.b": 1 }`, for tables. */
export function flattenStats(tree: StatsTree, prefix = ""): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "number") out[path] = value;
    else Object.assign(out, flattenStats(value, path));
  }
  return out;
}
