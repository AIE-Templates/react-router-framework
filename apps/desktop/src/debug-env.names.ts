// The environment variables that only some build profiles read, named once. The modules that read
// them take the names from here (~/debug-env.ts, ~/main/dev-host.ts), and so does the check that the
// other builds do not contain them (scripts/bundle-markers.ts, `pnpm verify:build`), so the two
// cannot drift apart. Nothing a release build bundles imports this file. Dependency-free and
// erasable TypeScript with no `~/` imports: plain Node imports it from scripts/ as well.

/** Read by dev and test builds (~/debug-env.ts), not even named in release builds. */
export const DEBUG_ENV = {
  bootProfile: "DESKTOP_BOOT_PROFILE",
  portAckCoalesce: "DESKTOP_PORT_ACK_COALESCE",
  smoke: "DESKTOP_SMOKE",
  smokeLayout: "DESKTOP_SMOKE_LAYOUT",
  smokeScreenshot: "DESKTOP_SMOKE_SCREENSHOT",
  bench: "DESKTOP_BENCH",
  benchCases: "DESKTOP_BENCH_CASES",
  benchWarmupMs: "DESKTOP_BENCH_WARMUP_MS",
  benchMeasureMs: "DESKTOP_BENCH_MEASURE_MS",
  benchLabel: "DESKTOP_BENCH_LABEL",
  e2e: "DESKTOP_E2E",
} as const;

/**
 * Read by the dev build only (~/main/dev-host.ts), not even named in test and release builds, whose
 * launchers choose the user data directory with `--user-data-dir` (scripts/launch.ts).
 */
export const DEV_ENV = {
  userDataSuffix: "DESKTOP_USER_DATA_SUFFIX",
} as const;
