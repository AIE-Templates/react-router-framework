/**
 * Three-way merge of package.json manifests by key, for conflicts that are only textual: two layers
 * adding or removing neighbouring lines of an alphabetically sorted dependency map. A key both sides
 * changed differently, or one side deleted while the other changed, is a real conflict and is
 * reported, never decided.
 *
 * Combination branches have criss-cross histories (two upstreams that each merged a common source at
 * different times), so a merge can have several bases. A side counts as unchanged when it equals the
 * key's value in any base; when both sides match different bases, the key is a conflict.
 *
 * Key order follows `ours`, with keys only `theirs` added appended; maps of dependencies are sorted,
 * the way oxfmt's sortPackageJson writes them.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface MergeConflict {
  /** JSON path of the key, e.g. `dependencies.react`. */
  path: string;
  reason: "both-changed" | "delete-modify";
}

export type MergeResult = { ok: true; value: Json } | { ok: false; conflicts: MergeConflict[] };

const SORTED_MAPS = new Set([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "scripts",
  "allowBuilds",
]);

const MISSING = Symbol("missing");
type Value = Json | typeof MISSING;

function isObject(value: Value): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function same(a: Value, b: Value): boolean {
  if (a === MISSING || b === MISSING) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function mergeValue(bases: Value[], ours: Value, theirs: Value, path: string, conflicts: MergeConflict[]): Value {
  if (same(ours, theirs)) return ours;
  const oursUnchanged = bases.some((base) => same(base, ours));
  const theirsUnchanged = bases.some((base) => same(base, theirs));
  if (oursUnchanged && !theirsUnchanged) return theirs;
  if (theirsUnchanged && !oursUnchanged) return ours;
  if (isObject(ours) && isObject(theirs)) {
    return mergeObject(
      bases.map((base) => (isObject(base) ? base : {})),
      ours,
      theirs,
      path,
      conflicts,
    );
  }
  conflicts.push({
    path,
    reason: ours === MISSING || theirs === MISSING ? "delete-modify" : "both-changed",
  });
  return ours;
}

function mergeObject(
  bases: { [key: string]: Json }[],
  ours: { [key: string]: Json },
  theirs: { [key: string]: Json },
  path: string,
  conflicts: MergeConflict[],
): { [key: string]: Json } {
  const keys = [...Object.keys(ours), ...Object.keys(theirs).filter((key) => !Object.hasOwn(ours, key))];
  const result: { [key: string]: Json } = {};
  for (const key of keys) {
    const at = (object: { [key: string]: Json }): Value => (Object.hasOwn(object, key) ? object[key] : MISSING);
    const merged = mergeValue(bases.map(at), at(ours), at(theirs), path ? `${path}.${key}` : key, conflicts);
    if (merged !== MISSING) result[key] = merged;
  }
  if (SORTED_MAPS.has(path.split(".").at(-1) ?? "")) {
    return Object.fromEntries(Object.entries(result).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  return result;
}

/**
 * Merges package.json texts: the version in each merge base (`undefined` where a base has no such
 * file), ours and theirs.
 */
export function mergePackageJson(bases: (string | undefined)[], ours: string, theirs: string): MergeResult {
  const conflicts: MergeConflict[] = [];
  const value = mergeValue(
    bases.map((base) => (base === undefined ? {} : (JSON.parse(base) as Json))),
    JSON.parse(ours) as Json,
    JSON.parse(theirs) as Json,
    "",
    conflicts,
  );
  return conflicts.length ? { ok: false, conflicts } : { ok: true, value: value as Json };
}

export function formatPackageJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
