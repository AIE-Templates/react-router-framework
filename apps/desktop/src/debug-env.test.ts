import { describe, expect, it, vi } from "vitest";

import { readDebugEnv as readNothing, utilityDebugEnv as forwardNothing } from "./debug-env.empty.ts";
import { readDebugEnv, utilityDebugEnv } from "./debug-env.ts";
import { PORT_ACK_COALESCE } from "./port-options.ts";

const everything = {
  DESKTOP_BOOT_PROFILE: "1",
  DESKTOP_USER_DATA_SUFFIX: "e2e-1",
  DESKTOP_PORT_ACK_COALESCE: "0",
  DESKTOP_SMOKE: "1",
  DESKTOP_SMOKE_LAYOUT: "1",
  DESKTOP_SMOKE_SCREENSHOT: "/tmp/smoke.png",
  DESKTOP_BENCH: "1",
  DESKTOP_BENCH_CASES: "api-c1",
  DESKTOP_BENCH_WARMUP_MS: "0",
  DESKTOP_BENCH_MEASURE_MS: "250",
  DESKTOP_BENCH_LABEL: "quiet",
  DESKTOP_E2E: "1",
};

/** A reading without its one function, for comparison. */
function values(env: ReturnType<typeof readDebugEnv>) {
  const { ackCoalesce: _, ...rest } = env;
  return rest;
}

describe("the debug environment of dev and test builds", () => {
  it("reports nothing as set in an empty environment", () => {
    const env = readDebugEnv({});
    expect(values(env)).toEqual(values(readNothing()));
    expect(env.ackCoalesce()).toBe(PORT_ACK_COALESCE);
  });

  it("reads every debug variable", () => {
    const env = readDebugEnv(everything);
    expect(values(env)).toEqual({
      bootProfile: true,
      userDataSuffix: "e2e-1",
      smoke: true,
      smokeLayout: true,
      smokeScreenshot: "/tmp/smoke.png",
      bench: true,
      benchCases: "api-c1",
      benchWarmupMs: "0",
      benchMeasureMs: "250",
      benchLabel: "quiet",
      e2e: true,
    });
    expect(env.ackCoalesce()).toBe(false);
  });

  it("turns flags on with 1 only", () => {
    const env = readDebugEnv({
      DESKTOP_SMOKE: "true",
      DESKTOP_BENCH: "0",
      DESKTOP_E2E: "",
      DESKTOP_BOOT_PROFILE: "yes",
    });
    expect(env).toMatchObject({ smoke: false, bench: false, e2e: false, bootProfile: false });
  });

  it("keeps ack coalescing when unset, empty or 1 and rejects anything but 0 or 1 when asked", () => {
    for (const value of [undefined, "", "1"]) {
      expect(readDebugEnv({ DESKTOP_PORT_ACK_COALESCE: value }).ackCoalesce()).toBe(PORT_ACK_COALESCE);
    }
    const env = readDebugEnv({ DESKTOP_PORT_ACK_COALESCE: "off" });
    expect(() => env.ackCoalesce()).toThrow(/DESKTOP_PORT_ACK_COALESCE/);
  });

  it("hands the utility the main process's decisions, clearing the runs it did not select", () => {
    const forwarded = utilityDebugEnv({ ackCoalesce: false, bench: false, smoke: true, e2e: false });
    expect(forwarded).toEqual({
      DESKTOP_PORT_ACK_COALESCE: "0",
      DESKTOP_BENCH: "",
      DESKTOP_SMOKE: "1",
      DESKTOP_E2E: "",
    });
    // The utility inherits the main process's environment under these.
    expect(readDebugEnv({ ...everything, ...forwarded })).toMatchObject({ bench: false, smoke: true, e2e: false });
    expect(readDebugEnv({ ...everything, ...forwarded }).ackCoalesce()).toBe(false);
  });
});

describe("the debug environment of release builds", () => {
  it("reads nothing, whatever is set, and passes nothing on", () => {
    for (const [name, value] of Object.entries(everything)) vi.stubEnv(name, value);
    try {
      const env = readNothing();
      expect(values(env)).toEqual({
        bootProfile: false,
        userDataSuffix: undefined,
        smoke: false,
        smokeLayout: false,
        smokeScreenshot: undefined,
        bench: false,
        benchCases: undefined,
        benchWarmupMs: undefined,
        benchMeasureMs: undefined,
        benchLabel: undefined,
        e2e: false,
      });
      expect(env.ackCoalesce()).toBe(PORT_ACK_COALESCE);
      expect(values(readNothing(everything))).toEqual(values(env));
      expect(forwardNothing({ ackCoalesce: false, bench: true, smoke: true, e2e: true })).toEqual({});
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
