import type { SelectMainRun, SelectUtilityDiagnostics } from "~/diagnostics/entry.contract.ts";

// What release builds bundle in place of ~/diagnostics/entry.ts (vite.base.config.ts): no run, no
// endpoint, and no import of anything else under src/diagnostics.

export const selectMainRun: SelectMainRun = () => ({
  modes: { bench: false, smoke: false, e2e: false },
  start: () => Promise.resolve(),
});

export const selectUtilityDiagnostics: SelectUtilityDiagnostics = () => ({
  extend: undefined,
  wrap: (fetch) => fetch,
});
