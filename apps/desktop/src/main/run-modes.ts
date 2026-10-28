/**
 * Which test-only run the main process starts, from its environment and build:
 * - `DESKTOP_BENCH=1`: the real-app benchmark (`/__bench/*`), unpackaged or the packaged test
 *   profile, never the release profile, never against the dev server (no utility).
 * - `DESKTOP_SMOKE=1`: the in-app smoke (`/__smoke/*`), any build: it is the release profile's own
 *   hardened self-check.
 * - `DESKTOP_E2E=1`: the Playwright run (`/__e2e/*`), unpackaged or the packaged test profile only.
 *   The release profile's inspector fuse already stops Playwright, but not a plain launch with the
 *   variable set, so the endpoints must never mount there.
 * At most one runs: bench, then smoke, then e2e.
 */
export interface RunModeInput {
  env: { DESKTOP_BENCH?: string; DESKTOP_SMOKE?: string; DESKTOP_E2E?: string };
  /** Pages come from `react-router dev`, not the utility. */
  development: boolean;
  packaged: boolean;
  /** The packaged electron-builder profile ("test" or "release"); read only when needed. */
  profile: () => string | undefined;
}

export interface RunModes {
  bench: boolean;
  smoke: boolean;
  e2e: boolean;
  /** Variables that were set but refused, with why, to log. */
  ignored: { variable: "DESKTOP_BENCH" | "DESKTOP_E2E"; reason: string }[];
}

export function resolveRunModes({ env, development, packaged, profile }: RunModeInput): RunModes {
  let testBuild: boolean | undefined;
  const isTestBuild = () => (testBuild ??= !packaged || profile() === "test");
  const ignored: RunModes["ignored"] = [];
  const bench = env.DESKTOP_BENCH === "1" && !development && isTestBuild();
  if (env.DESKTOP_BENCH === "1" && !bench) {
    ignored.push({ variable: "DESKTOP_BENCH", reason: "release profile or development" });
  }
  const smoke = env.DESKTOP_SMOKE === "1" && !bench;
  const e2e = env.DESKTOP_E2E === "1" && !bench && !smoke && isTestBuild();
  if (env.DESKTOP_E2E === "1" && !bench && !smoke && !e2e) {
    ignored.push({ variable: "DESKTOP_E2E", reason: "release profile" });
  }
  return { bench, smoke, e2e, ignored };
}
