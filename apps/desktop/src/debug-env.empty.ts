import type { DebugEnv, ReadDebugEnv, UtilityDebugEnv } from "~/debug-env.contract.ts";
import { PORT_ACK_COALESCE } from "~/port-options.ts";

// What release builds bundle in place of ~/debug-env.ts (vite.base.config.ts): no debug variable is
// read, named or passed on; every one of them is reported as unset.

const UNSET: DebugEnv = {
  bootProfile: false,
  ackCoalesce: () => PORT_ACK_COALESCE,
  smoke: false,
  smokeLayout: false,
  smokeScreenshot: undefined,
  bench: false,
  benchCases: undefined,
  benchWarmupMs: undefined,
  benchMeasureMs: undefined,
  benchLabel: undefined,
  e2e: false,
};

export const readDebugEnv: ReadDebugEnv = () => UNSET;

export const utilityDebugEnv: UtilityDebugEnv = () => ({});
