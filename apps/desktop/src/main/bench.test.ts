import { afterEach, describe, expect, it, vi } from "vitest";

import { runPageCase } from "./bench-page.ts";
import { BENCH_CASES, benchConfigFromEnv, counterDelta, processRole, UTILITY_SERVICE_NAME } from "./bench.ts";

describe("benchConfigFromEnv", () => {
  it("defaults to every case", () => {
    expect(benchConfigFromEnv({})).toMatchObject({ warmupMs: 1000, measureMs: 5000, cases: BENCH_CASES });
  });

  it("reads durations, a case list and a label", () => {
    const config = benchConfigFromEnv({
      DESKTOP_BENCH_WARMUP_MS: "0",
      DESKTOP_BENCH_MEASURE_MS: "2500",
      DESKTOP_BENCH_CASES: "api-c8, download-4m",
      DESKTOP_BENCH_LABEL: "quiet",
    });
    expect(config).toMatchObject({ warmupMs: 0, measureMs: 2500, label: "quiet" });
    expect(config.cases.map((c) => c.name)).toEqual(["api-c8", "download-4m"]);
  });

  it("rejects unknown cases and bad durations", () => {
    expect(() => benchConfigFromEnv({ DESKTOP_BENCH_CASES: "nope" })).toThrow(/Unknown bench case/);
    expect(() => benchConfigFromEnv({ DESKTOP_BENCH_MEASURE_MS: "5s" })).toThrow(/DESKTOP_BENCH_MEASURE_MS/);
  });
});

describe("processRole", () => {
  const pids = { main: 1, renderer: 2 };
  it("tells our processes apart", () => {
    expect(processRole({ pid: 1, type: "Browser" }, pids)).toBe("main");
    expect(processRole({ pid: 2, type: "Tab" }, pids)).toBe("renderer");
    expect(processRole({ pid: 3, type: "Utility", name: UTILITY_SERVICE_NAME }, pids)).toBe("utility");
    expect(processRole({ pid: 4, type: "Utility", name: "Network Service" }, pids)).toBe("other");
    expect(processRole({ pid: 5, type: "GPU" }, pids)).toBe("other");
  });
});

describe("counterDelta", () => {
  it("subtracts nested counters and keeps gauges", () => {
    expect(
      counterDelta(
        { framesSent: { ack: 10, request: 2 }, queuedBytes: 5, creditWaitMs: 1 },
        { framesSent: { ack: 15, request: 2 }, queuedBytes: 7, creditWaitMs: 4 },
        ["queuedBytes"],
      ),
    ).toEqual({ framesSent: { ack: 5, request: 0 }, queuedBytes: 7, creditWaitMs: 3 });
  });

  it("counts from zero without a before snapshot", () => {
    expect(counterDelta(undefined, { ack: 3 })).toEqual({ ack: 3 });
  });
});

describe("runPageCase", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("counts the bytes of every worker when they complete together", async () => {
    const body = '{"ok":true}';
    let clock = 0;
    let calls = 0;
    vi.stubGlobal("performance", { now: () => clock });
    vi.stubGlobal("fetch", async () => {
      // The run ends once all eight workers have their first request in flight.
      if (++calls === 8) clock = 2;
      return new Response(body);
    });
    const result = await runPageCase({ op: { kind: "health" }, concurrency: 8, record: true, durationMs: 1 });
    expect(result.foreground.ops).toBe(8);
    expect(result.foreground.bytes).toBe(8 * body.length);
  });
});
