import type { BenchOptions, LinkName, Suite, Variant, WsReceiver } from "./config.ts";
import type { Environment } from "./environment.ts";
import type { FetchResult } from "./fetch.ts";
import type { ProcessMetrics } from "./metrics.ts";
import type { StreamResult } from "./producer.ts";
import type { SendBudget } from "./scheduler.ts";
import type { StatsTree } from "./stats.ts";

/** One run of one case on one link; `stream` or `fetch` is set by the case kind. */
export interface RunResult {
  link: LinkName;
  case: string;
  variant: Variant;
  suite: Suite;
  seed: number;
  repeat: number;
  /** `sendBudget` is absent in files from before the cooperative send loop (not comparable on bulk latency). */
  params: {
    windowBytes: number;
    warmupMs: number;
    measureMs: number;
    sendBudget?: SendBudget;
    wsReceiver?: WsReceiver;
  };
  /** The `--options` this run passed to the packages (`{}`: their defaults; absent in older files). */
  options?: BenchOptions;
  /** Where the run process loaded the packages from (must be their `src/`; older files lack it). */
  packages?: { channel: string; portFetch: string };
  startedAt: string;
  stream?: StreamResult;
  fetch?: FetchResult;
  /** This process (the sender) during the measure window. */
  sender: ProcessMetrics;
  /**
   * The packages' `stats()` over the measure window (counters as deltas, gauges at the end), per
   * component: `sender` (the sender's channel), `peer` (the peer's channel), `relay`,
   * `relayInner` (the relay's port side), `relayOuter` (its socket side), `client` and `server`
   * (port-fetch). Absent for the raw variant and for package versions without counters.
   */
  stats?: Record<string, StatsTree>;
  error?: string;
}

export interface ResultFile {
  environment: Environment;
  /** `--label`, to tell result files apart (for example the options or the package build under test). */
  label?: string;
  /** `--options`, as given; every run also records its own copy. Absent in files from before the option. */
  options?: BenchOptions;
  runs: RunResult[];
}
