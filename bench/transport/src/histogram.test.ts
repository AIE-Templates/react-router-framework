import { describe, expect, it } from "vitest";

import { Histogram } from "./histogram.ts";

describe("Histogram", () => {
  it("reports percentiles from bucket upper edges across the resolution ranges", () => {
    const h = new Histogram();
    for (let i = 1; i <= 100; i++) h.record(i / 10); // 0.1 ms .. 10 ms
    const s = h.summary();
    expect(s.samples).toBe(100);
    expect(s.p50Ms).toBeGreaterThanOrEqual(5);
    expect(s.p50Ms).toBeLessThanOrEqual(5.02);
    expect(s.p99Ms).toBeGreaterThanOrEqual(9.9);
    expect(s.maxMs).toBe(10);
  });

  it("keeps the maximum exactly and handles values past the last range", () => {
    const h = new Histogram();
    h.record(0.0005);
    h.record(12_000);
    expect(h.summary().maxMs).toBe(12_000);
    expect(h.percentile(1)).toBe(12_000);
  });
});
