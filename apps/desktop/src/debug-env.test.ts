import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { readDebugEnv as readNothing, utilityDebugEnv as forwardNothing } from "./debug-env.empty.ts";
import { DEBUG_ENV, DEV_ENV } from "./debug-env.names.ts";
import { readDebugEnv, utilityDebugEnv } from "./debug-env.ts";
import { PORT_ACK_COALESCE } from "./port-options.ts";

const everything = {
  DESKTOP_BOOT_PROFILE: "1",
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

  it("reads exactly the variables the shared list names, each of them", () => {
    // The list `pnpm verify:build` checks release bundles against is the list of what is read here.
    expect(Object.keys(everything).toSorted()).toEqual(Object.values(DEBUG_ENV).toSorted());
    const unset = readDebugEnv({});
    for (const name of Object.values(DEBUG_ENV)) {
      // "0" is a value every variable reacts to or, for the flags, ignores; "1" turns the flags on.
      const reactsTo = (value: string) => {
        const env = readDebugEnv({ [name]: value });
        return (
          JSON.stringify([values(env), env.ackCoalesce()]) !== JSON.stringify([values(unset), unset.ackCoalesce()])
        );
      };
      expect({ name, read: reactsTo("0") || reactsTo("1") }).toEqual({ name, read: true });
    }
    // Never spelled out beside the list, where the check would not see a new one.
    expect(readFileSync(new URL("./debug-env.ts", import.meta.url), "utf8")).not.toMatch(/DESKTOP_/);
  });

  it("leaves the dev build's own variable alone", () => {
    const env = readDebugEnv({ [DEV_ENV.userDataSuffix]: "dev" });
    expect(values(env)).toEqual(values(readDebugEnv({})));
    expect(Object.values<string>(DEBUG_ENV)).not.toContain(DEV_ENV.userDataSuffix);
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
