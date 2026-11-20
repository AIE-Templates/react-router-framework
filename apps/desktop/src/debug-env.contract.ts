import type { AckCoalesceOptions } from "@repo/port-fetch";

/**
 * The debug environment variables, the ones only dev and test builds honour (DEBUG_ENV in
 * ~/debug-env.names.ts), as one process read them: `~/debug-env.ts` reads them in those builds;
 * release builds get `~/debug-env.empty.ts` in its place (vite.base.config.ts), which reads nothing
 * and reports every one of them as unset. Nothing else reads these variables. LOG_LEVEL,
 * DESKTOP_CHROME_MODE and the system's XDG_* variables are not debug variables: every build reads
 * them where they are used. DESKTOP_USER_DATA_SUFFIX is the dev build's alone (~/main/dev-host.ts).
 */
export interface DebugEnv {
  /** `DESKTOP_BOOT_PROFILE=1`: print the startup segments (src/main/boot-profile.ts). */
  bootProfile: boolean;
  /**
   * `DESKTOP_PORT_ACK_COALESCE`: unset, empty or `1` keeps `PORT_ACK_COALESCE` (src/port-options.ts),
   * `0` turns coalescing off, for the real-app benchmark, which runs both. Anything else throws when
   * called, so a typo never measures the wrong mode.
   */
  ackCoalesce: () => AckCoalesceOptions | false;
  /** `DESKTOP_SMOKE=1`: the in-app smoke. In the utility: the main process runs the smoke. */
  smoke: boolean;
  /** `DESKTOP_SMOKE_LAYOUT=1`: the smoke also runs the demo fixture matrix. */
  smokeLayout: boolean;
  /** `DESKTOP_SMOKE_SCREENSHOT=<file.png>`: the smoke saves what the window shows. */
  smokeScreenshot: string | undefined;
  /** `DESKTOP_BENCH=1`: the real-app benchmark. In the utility: the main process runs the benchmark. */
  bench: boolean;
  /** `DESKTOP_BENCH_CASES`, `_WARMUP_MS`, `_MEASURE_MS` and `_LABEL`, as set (src/diagnostics/bench/bench.ts). */
  benchCases: string | undefined;
  benchWarmupMs: string | undefined;
  benchMeasureMs: string | undefined;
  benchLabel: string | undefined;
  /** `DESKTOP_E2E=1`: a Playwright run. In the utility: mount the end-to-end endpoints. */
  e2e: boolean;
}

/** What the main process decided and the utility process must follow. */
export interface UtilityDebugSettings {
  ackCoalesce: AckCoalesceOptions | false;
  bench: boolean;
  smoke: boolean;
  e2e: boolean;
}

/** Reads the debug variables of this process (`env`: for tests). */
export type ReadDebugEnv = (env?: Record<string, string | undefined>) => DebugEnv;

/**
 * The variables the main process sets on the utility process, over the inherited ones, so that the
 * utility's `ReadDebugEnv` reports what the main process decided rather than what the user set.
 */
export type UtilityDebugEnv = (settings: UtilityDebugSettings) => Record<string, string>;
