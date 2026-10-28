import type { PeerCloseReport } from "./backlog.ts";
import {
  type BenchOptions,
  LINKS,
  type LinkName,
  type RunConfig,
  type Suite,
  SUITES,
  type Variant,
  type WsReceiver,
} from "./config.ts";
import type { ProcessMetrics } from "./metrics.ts";
import type { PeerStats } from "./peer.ts";
import type { ResultFile, RunResult } from "./result.ts";
import type { CaseSpec } from "./workload.ts";

/**
 * Type guards for what crosses a process or thread boundary as JSON or workerData. They check the
 * shape far enough to catch a wrong file or a stale protocol; the numbers inside are trusted.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isSuite(value: unknown): value is Suite {
  return typeof value === "string" && value in SUITES;
}

export function isLinkName(value: unknown): value is LinkName {
  return typeof value === "string" && (LINKS as readonly string[]).includes(value);
}

export function isVariant(value: unknown): value is Variant {
  return value === "raw" || value === "package";
}

export function isCaseSpec(value: unknown): value is CaseSpec {
  return isRecord(value) && typeof value.name === "string" && typeof value.description === "string";
}

export function isRunConfig(value: unknown): value is RunConfig {
  return (
    isRecord(value) &&
    isLinkName(value.link) &&
    isVariant(value.variant) &&
    isSuite(value.suite) &&
    typeof value.seed === "number" &&
    isCaseSpec(value.caseSpec) &&
    typeof value.windowBytes === "number" &&
    typeof value.warmupMs === "number" &&
    typeof value.measureMs === "number" &&
    isRecord(value.sendBudget) &&
    typeof value.sendBudget.bytes === "number" &&
    typeof value.sendBudget.ms === "number" &&
    isBenchOptions(value.options) &&
    (value.wsReceiver === undefined || isWsReceiver(value.wsReceiver))
  );
}

export function isWsReceiver(value: unknown): value is WsReceiver {
  return value === "pausable" || value === "standard";
}

/** The peer's close report; only the fields the sender reads are checked. */
export function isPeerCloseReport(value: unknown): value is PeerCloseReport {
  return (
    isRecord(value) &&
    typeof value.atEpochMs === "number" &&
    isRecord(value.consumed) &&
    isRecord(value.droppedAtClose) &&
    isRecord(value.memoryAtClose) &&
    isRecord(value.memoryAfter) &&
    isPeerStats(value.stats)
  );
}

const OPTION_GROUPS = ["channel", "portFetch", "relay"];

/**
 * `{ channel?, portFetch?, relay? }` with objects as values. Only the shape is checked here; the
 * packages validate the values themselves when the channel, client or relay is created.
 */
export function isBenchOptions(value: unknown): value is BenchOptions {
  return (
    isRecord(value) &&
    !Array.isArray(value) &&
    Object.entries(value).every(([key, group]) => OPTION_GROUPS.includes(key) && isRecord(group))
  );
}

export function isProcessMetrics(value: unknown): value is ProcessMetrics {
  return isRecord(value) && typeof value.wallMs === "number" && isRecord(value.cpu) && isRecord(value.memory);
}

export function isPeerStats(value: unknown): value is PeerStats {
  return isRecord(value) && isRecord(value.consumed) && typeof value.pausedMs === "number";
}

export function isRunResult(value: unknown): value is RunResult {
  return (
    isRecord(value) &&
    (typeof value.error === "string" || (typeof value.link === "string" && typeof value.case === "string"))
  );
}

export function isResultFile(value: unknown): value is ResultFile {
  return isRecord(value) && Array.isArray(value.runs) && isRecord(value.environment);
}

export function parseJson(text: string): unknown {
  return JSON.parse(text);
}

export function expect<T>(value: unknown, guard: (v: unknown) => v is T, what: string): T {
  if (!guard(value)) throw new Error(`unexpected ${what}: ${JSON.stringify(value).slice(0, 200)}`);
  return value;
}
