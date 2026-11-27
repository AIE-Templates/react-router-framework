import type { SelectMainRun, SelectUtilityDiagnostics } from "~/diagnostics/entry.contract.ts";
import { resolveRunModes } from "~/main/run-modes.ts";

import { benchConfigFrom, runBench } from "./bench/bench.ts";
import { withBenchRoutes } from "./bench/routes.ts";
import { E2E_PREFIX, e2eRoutes } from "./e2e/routes.ts";
import { SMOKE_PREFIX, smokeRoutes } from "./smoke/routes.ts";
import { runSmoke } from "./smoke/smoke.ts";

// The one way into src/diagnostics for the process entries, in dev and test builds. Release builds
// bundle ~/diagnostics/entry.empty.ts instead (vite.base.config.ts), so nothing under this directory
// is in them. Import it as `~/diagnostics/entry.ts`, the specifier the build replaces. Two separate
// exports, so the main bundle carries no routes and the utility bundle no runners.

export const selectMainRun: SelectMainRun = (debug, { development, log }) => {
  const { ignored, ...modes } = resolveRunModes({
    bench: debug.bench,
    smoke: debug.smoke,
    e2e: debug.e2e,
    development,
  });
  for (const { variable, reason } of ignored) log.warn({ reason }, `${variable} ignored`);
  const benchConfig = modes.bench ? benchConfigFrom(debug) : undefined;
  return {
    modes,
    firstWindowGate:
      modes.e2e && process.argv.includes("--e2e-hold-first-window")
        ? new Promise<void>((resolve) => {
            globalThis.e2eReleaseFirstWindow = resolve;
          })
        : undefined,
    async start(context) {
      if (benchConfig && context.server) {
        const utility = context.server;
        await runBench({
          win: context.window,
          config: benchConfig,
          ackCoalesce: context.ackCoalesce,
          log: context.log,
          getAppMetrics: context.getAppMetrics,
          utilityFetch: utility.fetch,
          internalOrigin: context.internalOrigin,
          clientStats: () => utility.stats(),
          exit: context.exit,
        });
      } else if (modes.smoke) {
        // Stop through the same utility shutdown path as a completed smoke. Chromium's
        // native signal handler can tear down the renderer while a check is evaluating JS.
        let interrupt!: () => void;
        const interrupted = new Promise<number>((resolve) => {
          interrupt = () => resolve(1);
        });
        process.once("SIGINT", interrupt);
        process.once("SIGTERM", interrupt);
        process.once("SIGHUP", interrupt);
        try {
          const result = runSmoke(context.window, {
            profile: context.bootProfile,
            log: context.log,
            development: context.development,
            smokeRoutes: context.server !== undefined,
            layout: debug.smokeLayout,
            screenshot: debug.smokeScreenshot,
          });
          await context.exit(await Promise.race([result, interrupted]));
        } finally {
          process.off("SIGINT", interrupt);
          process.off("SIGTERM", interrupt);
          process.off("SIGHUP", interrupt);
        }
      }
    },
  };
};

// The main process sets the run flags on the utility (it clears the ones it did not select), so
// here they mean what the main process runs.
export const selectUtilityDiagnostics: SelectUtilityDiagnostics = (debug, helpers) => ({
  extend:
    debug.smoke || debug.e2e
      ? (app) => {
          if (debug.smoke) app.route(SMOKE_PREFIX, smokeRoutes(helpers));
          if (debug.e2e) app.route(E2E_PREFIX, e2eRoutes());
        }
      : undefined,
  wrap: (fetch, serverStats) => (debug.bench ? withBenchRoutes(fetch, serverStats) : fetch),
});
