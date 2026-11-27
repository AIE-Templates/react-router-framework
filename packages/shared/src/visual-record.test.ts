import { expect, it } from "vitest";

import {
  createVisualRecordKernel,
  VISUAL_DEFAULTS,
  visualRecordKernel as kernel,
  type VisualPreferences,
  type VisualRecord,
} from "./visual-record.ts";

function record(t: number, preferences: Partial<VisualPreferences> = {}, id = "a"): VisualRecord {
  return { version: 1, stamp: { t, id }, preferences };
}

it("selects the first present record in native, cookie, local order regardless of time", () => {
  const native = record(1);
  const cookie = record(2);
  const local = record(3);
  expect(kernel.atStart({ native, cookie, local })).toBe(native);
  expect(kernel.atStart({ cookie, local })).toBe(cookie);
  expect(kernel.atStart({ local })).toBe(local);
  expect(kernel.atStart({})).toBeUndefined();
});

it("accepts stamps through the Date limit and 64 ID code units", () => {
  const upper = record(8.64e15, {}, "a".repeat(64));
  expect(kernel.decode(kernel.encode(upper)).record).toEqual(upper);
  expect(kernel.nextStamp([upper], 0).t).toBe(8.64e15 + 1);
  for (const invalid of [record(8.64e15 + 1), record(0, {}, "a".repeat(65))]) {
    expect(kernel.decode(kernel.encode(invalid))).toEqual({ kind: "invalid" });
  }
});

it("orders by time, code units and canonical sparse JSON, independently of key order", () => {
  const a = record(1, { direction: "rtl", colorScheme: "dark" });
  const b = record(1, { colorScheme: "dark", direction: "rtl" });
  expect(kernel.encode(a)).toBe(
    '{"version":1,"stamp":{"t":1,"id":"a"},"preferences":{"colorScheme":"dark","direction":"rtl"}}',
  );
  expect(kernel.encode(b)).toBe(kernel.encode(a));
  expect(kernel.compare(a, b)).toBe(0);
  const ordered = [record(0), record(1, {}, "Z"), a, record(1, { direction: "rtl" }), record(1), record(2)];
  for (const [i, first] of ordered.entries()) {
    for (const [j, second] of ordered.entries()) {
      expect(kernel.compare(first, second)).toBe(Math.sign(i - j));
      for (const [k, third] of ordered.entries()) {
        const winner = ordered[Math.max(i, j, k)];
        expect(kernel.pick([first, second, third])).toEqual(winner);
        expect(kernel.pick([kernel.pick([first, second]), third, first])).toEqual(winner);
      }
    }
  }
});
it("advances the maximum observed clock after rollback and generates a random id per commit", () => {
  expect(kernel.nextStamp([record(200), record(300)], 10, () => "next")).toEqual({ t: 301, id: "next" });
  expect(kernel.nextStamp([], 400).t).toBe(400);
  expect(kernel.nextStamp([], 400).id).not.toBe(kernel.nextStamp([], 400).id);
});
it.each([
  ["G1", "auto", {}, "auto"],
  ["G2", "light", {}, "light"],
  ["G3", "light", { colorScheme: "dark" }, "dark"],
  ["G4", "light", { reducedMotion: "reduce" }, "light"],
  ["G5", "light", { colorScheme: "light" }, "light"],
  ["G6", "light", { direction: "rtl" }, "light"],
  ["G7", "light", {}, "light"],
  ["G8", "auto", {}, "auto"],
  ["G9", "auto", { colorScheme: "light" }, "light"],
] as const)("%s fills only omitted fields from product defaults", (_, colorScheme, preferences, expected) => {
  const product = createVisualRecordKernel({ ...VISUAL_DEFAULTS, colorScheme });
  const stored = product.decode(product.encode(record(1, preferences))).record;
  expect(stored?.preferences).toEqual(preferences);
  expect(product.effective(stored).colorScheme).toBe(expected);
});
it.each([
  null,
  [],
  {},
  { ...record(1), version: 2 },
  { ...record(1), extra: true },
  ...[
    null,
    [],
    { t: -1, id: "x" },
    { t: 1.5, id: "x" },
    { t: 0, id: "" },
    { t: 0, id: 42 },
    { t: 0, id: "x", foo: 0 },
  ].map((stamp) => ({ ...record(1), stamp })),
  ...[
    null,
    [],
    { direction: "auto" },
    { colorScheme: "blue", direction: "rtl" },
    { reducedMotion: true },
    { unknown: "auto" },
  ].map((preferences) => ({ ...record(1), preferences })),
])("G11 rejects the whole malformed record %#", (value) => {
  expect(kernel.decode(JSON.stringify(value))).toEqual({ kind: "invalid" });
});
it("distinguishes a missing value from an empty or corrupt payload", () => {
  expect(kernel.decode(null)).toEqual({ kind: "missing" });
  expect(kernel.decode("")).toEqual({ kind: "invalid" });
  expect(kernel.decode("{")).toEqual({ kind: "invalid" });
});
