import type { AckCoalesceOptions } from "@repo/port-fetch";

import type { ReadDebugEnv, UtilityDebugEnv } from "~/debug-env.contract.ts";
import { PORT_ACK_COALESCE } from "~/port-options.ts";

// The only module that reads the debug environment variables, for dev and test builds. Release
// builds bundle ~/debug-env.empty.ts instead (vite.base.config.ts), so they neither read these
// variables nor contain their names. Import it as `~/debug-env.ts`, the specifier the build replaces.

function portAckCoalesce(value: string | undefined): AckCoalesceOptions | false {
  if (value === undefined || value === "" || value === "1") return PORT_ACK_COALESCE;
  if (value === "0") return false;
  throw new Error(`Invalid DESKTOP_PORT_ACK_COALESCE "${value}": expected 0 or 1`);
}

export const readDebugEnv: ReadDebugEnv = (env = process.env) => ({
  bootProfile: env.DESKTOP_BOOT_PROFILE === "1",
  userDataSuffix: env.DESKTOP_USER_DATA_SUFFIX || undefined,
  ackCoalesce: () => portAckCoalesce(env.DESKTOP_PORT_ACK_COALESCE),
  smoke: env.DESKTOP_SMOKE === "1",
  smokeLayout: env.DESKTOP_SMOKE_LAYOUT === "1",
  smokeScreenshot: env.DESKTOP_SMOKE_SCREENSHOT || undefined,
  bench: env.DESKTOP_BENCH === "1",
  benchCases: env.DESKTOP_BENCH_CASES,
  benchWarmupMs: env.DESKTOP_BENCH_WARMUP_MS,
  benchMeasureMs: env.DESKTOP_BENCH_MEASURE_MS,
  benchLabel: env.DESKTOP_BENCH_LABEL,
  e2e: env.DESKTOP_E2E === "1",
});

// Every run flag is set, to "" when off: the utility inherits the main process's environment, and a
// variable the user set must not reach it when the main process refused or outranked that run.
export const utilityDebugEnv: UtilityDebugEnv = ({ ackCoalesce, bench, smoke, e2e }) => ({
  DESKTOP_PORT_ACK_COALESCE: ackCoalesce ? "1" : "0",
  DESKTOP_BENCH: bench ? "1" : "",
  DESKTOP_SMOKE: smoke ? "1" : "",
  DESKTOP_E2E: e2e ? "1" : "",
});
