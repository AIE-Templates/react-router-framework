/**
 * Which test-only run the main process starts, from the debug environment (~/debug-env.ts). Dev and
 * test builds only: the diagnostics entry (~/diagnostics/entry.ts) is its one caller, and release
 * builds contain neither.
 * - `DESKTOP_BENCH=1`: the real-app benchmark (`/__bench/*`), never against the dev server, which
 *   has no utility to measure.
 * - `DESKTOP_SMOKE=1`: the in-app smoke (`/__smoke/*`).
 * - `DESKTOP_E2E=1`: the Playwright run (`/__e2e/*`).
 * At most one runs: bench, then smoke, then e2e.
 */
export interface RunModeInput {
  bench: boolean;
  smoke: boolean;
  e2e: boolean;
  /** Pages come from `react-router dev`, not the utility. */
  development: boolean;
}

export interface RunModes {
  bench: boolean;
  smoke: boolean;
  e2e: boolean;
  /** Variables that were set but refused, with why, to log. */
  ignored: { variable: "DESKTOP_BENCH"; reason: string }[];
}

export function resolveRunModes(requested: RunModeInput): RunModes {
  const ignored: RunModes["ignored"] = [];
  const bench = requested.bench && !requested.development;
  if (requested.bench && !bench) ignored.push({ variable: "DESKTOP_BENCH", reason: "development" });
  const smoke = requested.smoke && !bench;
  const e2e = requested.e2e && !bench && !smoke;
  return { bench, smoke, e2e, ignored };
}
