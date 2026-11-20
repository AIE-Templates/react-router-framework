import type { AckCoalesceOptions } from "@repo/port-fetch";

import type { ReadDebugEnv, UtilityDebugEnv } from "~/debug-env.contract.ts";
import { DEBUG_ENV } from "~/debug-env.names.ts";
import { PORT_ACK_COALESCE } from "~/port-options.ts";

// The only module that reads the debug environment variables, for dev and test builds. Release
// builds bundle ~/debug-env.empty.ts instead (vite.base.config.ts), so they neither read these
// variables nor contain their names. Import it as `~/debug-env.ts`, the specifier the build replaces.
// Every name comes from ~/debug-env.names.ts, the list `pnpm verify:build` checks release builds
// against: never spell one out here.

function portAckCoalesce(value: string | undefined): AckCoalesceOptions | false {
  if (value === undefined || value === "" || value === "1") return PORT_ACK_COALESCE;
  if (value === "0") return false;
  throw new Error(`Invalid ${DEBUG_ENV.portAckCoalesce} "${value}": expected 0 or 1`);
}

export const readDebugEnv: ReadDebugEnv = (env = process.env) => ({
  bootProfile: env[DEBUG_ENV.bootProfile] === "1",
  ackCoalesce: () => portAckCoalesce(env[DEBUG_ENV.portAckCoalesce]),
  smoke: env[DEBUG_ENV.smoke] === "1",
  smokeLayout: env[DEBUG_ENV.smokeLayout] === "1",
  smokeScreenshot: env[DEBUG_ENV.smokeScreenshot] || undefined,
  bench: env[DEBUG_ENV.bench] === "1",
  benchCases: env[DEBUG_ENV.benchCases],
  benchWarmupMs: env[DEBUG_ENV.benchWarmupMs],
  benchMeasureMs: env[DEBUG_ENV.benchMeasureMs],
  benchLabel: env[DEBUG_ENV.benchLabel],
  e2e: env[DEBUG_ENV.e2e] === "1",
});

// Every run flag is set, to "" when off: the utility inherits the main process's environment, and a
// variable the user set must not reach it when the main process refused or outranked that run.
export const utilityDebugEnv: UtilityDebugEnv = ({ ackCoalesce, bench, smoke, e2e }) => ({
  [DEBUG_ENV.portAckCoalesce]: ackCoalesce ? "1" : "0",
  [DEBUG_ENV.bench]: bench ? "1" : "",
  [DEBUG_ENV.smoke]: smoke ? "1" : "",
  [DEBUG_ENV.e2e]: e2e ? "1" : "",
});
