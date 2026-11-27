/* oxlint-disable unicorn/consistent-function-scoping -- The record kernel is serialized into the prepaint script. */
export interface VisualPreferences {
  colorScheme: "auto" | "light" | "dark";
  direction: "ltr" | "rtl";
  reducedMotion: "auto" | "reduce" | "full";
}

export const VISUAL_DEFAULTS: Readonly<VisualPreferences> = Object.freeze({
  colorScheme: "auto",
  direction: "ltr",
  reducedMotion: "auto",
});

export interface VisualRecord {
  version: 1;
  stamp: { t: number; id: string };
  preferences: Partial<VisualPreferences>;
}

export function createVisualRecordKernel(defaults: Readonly<VisualPreferences>) {
  const maxDateTime = 8.64e15;
  const maxStampIdLength = 64;

  function object(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function canonical({ colorScheme, direction, reducedMotion }: Partial<VisualPreferences>) {
    return { colorScheme, direction, reducedMotion };
  }
  function encode({ stamp: { t, id }, preferences }: VisualRecord) {
    return JSON.stringify({ version: 1, stamp: { t, id }, preferences: canonical(preferences) });
  }
  function decode(
    raw: string | null,
  ): { kind: "missing" | "invalid"; record?: undefined } | { kind: "valid"; record: VisualRecord } {
    if (raw === null) return { kind: "missing" };
    try {
      const value: unknown = JSON.parse(raw);
      if (!object(value) || value.version !== 1 || Object.keys(value).length !== 3) return { kind: "invalid" };
      const { stamp, preferences } = value;
      if (
        !object(stamp) ||
        Object.keys(stamp).length !== 2 ||
        typeof stamp.t !== "number" ||
        !Number.isSafeInteger(stamp.t) ||
        stamp.t < 0 ||
        stamp.t > maxDateTime ||
        typeof stamp.id !== "string" ||
        !stamp.id ||
        stamp.id.length > maxStampIdLength ||
        !object(preferences)
      )
        return { kind: "invalid" };
      for (const [key, field] of Object.entries(preferences)) {
        if (key === "direction" && (field === "ltr" || field === "rtl")) continue;
        if (key === "colorScheme" && (field === "auto" || field === "light" || field === "dark")) continue;
        if (key === "reducedMotion" && (field === "auto" || field === "reduce" || field === "full")) continue;
        return { kind: "invalid" };
      }
      return { kind: "valid", record: { version: 1, stamp: { t: stamp.t, id: stamp.id }, preferences } };
    } catch {
      return { kind: "invalid" };
    }
  }
  function compareString(a: string, b: string) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  function compare(a: VisualRecord, b: VisualRecord) {
    return (
      Math.sign(a.stamp.t - b.stamp.t) ||
      compareString(a.stamp.id, b.stamp.id) ||
      compareString(JSON.stringify(canonical(a.preferences)), JSON.stringify(canonical(b.preferences)))
    );
  }
  function behind(current: VisualRecord | undefined, target: VisualRecord) {
    return !current || compare(current, target) < 0;
  }
  function atStart(sources: { native?: VisualRecord; cookie?: VisualRecord; local?: VisualRecord }) {
    return sources.native ?? sources.cookie ?? sources.local;
  }
  function pick(records: readonly (VisualRecord | undefined)[]) {
    let latest: VisualRecord | undefined;
    for (const record of records) if (record && behind(latest, record)) latest = record;
    return latest;
  }
  function effective(record?: Pick<VisualRecord, "preferences">): VisualPreferences {
    return { ...defaults, ...record?.preferences };
  }
  function randomId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
  function nextStamp(seen: readonly (VisualRecord | undefined)[], now = Date.now(), random = randomId) {
    const t = Math.max(now, (pick(seen)?.stamp.t ?? -1) + 1);
    if (!Number.isSafeInteger(t)) throw new RangeError("Visual timestamp exceeds safe integer precision");
    return { t, id: random() };
  }
  return { decode, encode, compare, behind, atStart, pick, effective, nextStamp };
}

export const visualRecordKernel = createVisualRecordKernel(VISUAL_DEFAULTS);
