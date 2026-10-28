import { describe, expect, it } from "vitest";

import { diffStats, flattenStats, statsWindow, toStatsTree } from "./stats.ts";

describe("stats", () => {
  it("diffs counters, keeps gauges and recurses", () => {
    const before = { acksSent: 10, heldBytes: 500, aToB: { frames: 4, heldBytes: 1 }, creditWaitMs: 1.5 };
    const after = { acksSent: 25, heldBytes: 200, aToB: { frames: 9, heldBytes: 0 }, creditWaitMs: 2.25 };
    expect(diffStats(before, after)).toEqual({
      acksSent: 15,
      heldBytes: 200,
      aToB: { frames: 5, heldBytes: 0 },
      creditWaitMs: 0.75,
    });
  });

  it("keeps only numbers and records, and reads a window", () => {
    let n = 1;
    const window = statsWindow(() => toStatsTree({ n, label: "x", nested: { m: n * 2 } }));
    window.start();
    n = 4;
    expect(window.stop()).toEqual({ n: 3, nested: { m: 6 } });
    expect(toStatsTree(undefined)).toBeUndefined();
    expect(flattenStats({ a: 1, b: { c: 2 } })).toEqual({ a: 1, "b.c": 2 });
  });
});
