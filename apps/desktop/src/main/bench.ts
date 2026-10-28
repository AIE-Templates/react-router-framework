import type { PortStats } from "@repo/port-fetch";
import type { BrowserWindow, ProcessMetric } from "electron";

import type { BenchProc } from "../bench-routes.ts";
import { type PageCaseResult, type PageCaseSpec, type PageOp, runPageCase } from "./bench-page.ts";
import type { Logger } from "./log.ts";

/**
 * `DESKTOP_BENCH=1` (unpackaged or the packaged test profile): the real-app transport benchmark. Once the page has hydrated,
 * runs each case in the renderer (closed-loop `fetch` from page JavaScript through `app://`, the
 * protocol handler, port-fetch and the utility's web app), measures CPU and memory of every process
 * over each measure window, prints one `BENCH_RESULT {...}` line and exits. `scripts/bench.ts`
 * launches it in fresh processes and compares the modes; see the README, "Real-app benchmark".
 */

const MiB = 1024 * 1024;

export interface BenchCase {
  name: string;
  op: PageOp | { kind: "assets" };
  concurrency: number;
  background?: { op: PageOp; concurrency: number };
}

/**
 * The cases, in run order (the same in every run, so memory carried over from earlier cases is the
 * same for both modes). `assets` gets its URL list from the loaded page.
 */
export const BENCH_CASES: readonly BenchCase[] = [
  { name: "api-c1", op: { kind: "health" }, concurrency: 1 },
  { name: "api-c8", op: { kind: "health" }, concurrency: 8 },
  { name: "bytes4k-c1", op: { kind: "bytes", bytes: 4096 }, concurrency: 1 },
  { name: "document-c1", op: { kind: "document" }, concurrency: 1 },
  { name: "assets-c1", op: { kind: "assets" }, concurrency: 1 },
  { name: "download-4m", op: { kind: "bytes", bytes: 4 * MiB }, concurrency: 1 },
  {
    name: "api-behind-download",
    op: { kind: "health" },
    concurrency: 1,
    background: { op: { kind: "bytes", bytes: 32 * MiB }, concurrency: 1 },
  },
  // Last: Chromium keeps much of the upload bodies' memory in the renderer afterwards, which would
  // show up in the peak working set of every case after it.
  { name: "upload-4m", op: { kind: "upload", bytes: 4 * MiB }, concurrency: 1 },
];

export interface BenchConfig {
  warmupMs: number;
  measureMs: number;
  cases: readonly BenchCase[];
  /** Free text stored in the result (`DESKTOP_BENCH_LABEL`). */
  label?: string;
}

/** The configuration from `DESKTOP_BENCH_*` (read by the main entry and passed in). */
export function benchConfigFromEnv(env: Record<string, string | undefined>): BenchConfig {
  const ms = (name: string, fallback: number): number => {
    const value = env[name];
    if (value === undefined || value === "") return fallback;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid ${name} "${value}": expected milliseconds`);
    return n;
  };
  const names = env.DESKTOP_BENCH_CASES?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const cases = names?.length
    ? names.map((name) => {
        const found = BENCH_CASES.find((c) => c.name === name);
        if (!found)
          throw new Error(`Unknown bench case "${name}": expected ${BENCH_CASES.map((c) => c.name).join(", ")}`);
        return found;
      })
    : BENCH_CASES;
  return {
    warmupMs: ms("DESKTOP_BENCH_WARMUP_MS", 1000),
    measureMs: ms("DESKTOP_BENCH_MEASURE_MS", 5000),
    cases,
    label: env.DESKTOP_BENCH_LABEL || undefined,
  };
}

/** Which of our processes a metric belongs to. */
export type ProcessRole = "main" | "utility" | "renderer" | "other";
const ROLES: readonly ProcessRole[] = ["main", "utility", "renderer", "other"];

function perRole<T>(value: (role: ProcessRole) => T): Record<ProcessRole, T> {
  return { main: value("main"), utility: value("utility"), renderer: value("renderer"), other: value("other") };
}

export function processRole(
  metric: Pick<ProcessMetric, "pid" | "type" | "name">,
  pids: { main: number; renderer: number },
): ProcessRole {
  if (metric.pid === pids.main) return "main";
  if (metric.pid === pids.renderer) return "renderer";
  if (metric.type === "Utility" && metric.name === UTILITY_SERVICE_NAME) return "utility";
  return "other";
}

/** `serviceName` given to `utilityProcess.fork` in server-process.ts; Electron reports it as the metric's `name`. */
export const UTILITY_SERVICE_NAME = "web-server";

/** `after - before` for every number in a (nested) counter object; gauges are taken from `after`. */
export function counterDelta(before: unknown, after: unknown, gauges: readonly string[] = []): unknown {
  if (typeof after === "number") return typeof before === "number" ? after - before : after;
  if (typeof after !== "object" || after === null) return after;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    const prior: unknown = typeof before === "object" && before !== null ? Reflect.get(before, key) : undefined;
    out[key] = gauges.includes(key) ? value : counterDelta(prior, value, gauges);
  }
  return out;
}

const STAT_GAUGES = ["queuedBytes", "peakQueuedBytes", "activeRequests"];

interface Snapshot {
  at: number;
  mainCpu: NodeJS.CpuUsage;
  metrics: ProcessMetric[];
  utility?: BenchProc;
  client?: PortStats;
}

export interface RoleUsage {
  /** CPU time over the measure window, in milliseconds. */
  cpuMs: number;
  /** `cpuMs` per wall millisecond (1 = one core busy). */
  cpuUtil: number;
  /** The highest working set sampled during the window (every 100 ms and at both ends), MiB. */
  peakWorkingSetMiB: number;
}

export interface BenchCaseResult {
  name: string;
  spec: Omit<PageCaseSpec, "record" | "durationMs">;
  /** Main-process clock over the measure window (snapshot to snapshot). */
  wallMs: number;
  page: PageCaseResult;
  /** Foreground ops per second and MiB per second on the renderer clock. */
  opsPerSec: number;
  mibPerSec: number;
  background?: { opsPerSec: number; mibPerSec: number };
  /** Main and utility CPU from their own `process.cpuUsage()`; renderer and the rest from `app.getAppMetrics()`. */
  usage: Record<ProcessRole, RoleUsage>;
  /** The same window from `app.getAppMetrics()` for main and utility too, as a cross-check. */
  appMetricsCpuMs: Record<ProcessRole, number>;
  /** The utility's `process.memoryUsage()` at the end of the window, MiB. */
  utilityMemoryMiB?: { rss: number; heapUsed: number; external: number; arrayBuffers: number };
  /** Port-fetch counters over the window: the main end (`client`) and the utility end (`server`). */
  portStats: { client?: unknown; server?: unknown };
}

export interface BenchDeps {
  win: BrowserWindow;
  config: BenchConfig;
  /** Whether ack coalescing is on, for the result. */
  ackCoalesce: unknown;
  log: Logger;
  getAppMetrics: () => ProcessMetric[];
  /** Fetches from the utility directly (not through the renderer), for `/__bench/proc`. */
  utilityFetch: (request: Request) => Promise<Response>;
  internalOrigin: string;
  clientStats: () => PortStats | undefined;
  exit: (code: number) => Promise<void>;
}

export async function runBench(deps: BenchDeps): Promise<void> {
  const { win, config, log } = deps;
  const started = Date.now();
  try {
    win.webContents.setBackgroundThrottling(false);
    const js = (code: string, timeoutMs: number): Promise<unknown> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race<unknown>([
        win.webContents.executeJavaScript(code),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("bench step timed out")), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
    };
    const hydrated = await js(
      `(async () => { const d = document.documentElement; const until = Date.now() + 10000; while (d.dataset.hydrated !== "true" && Date.now() < until) await new Promise((r) => setTimeout(r, 20)); return d.dataset.hydrated === "true"; })()`,
      15_000,
    );
    if (hydrated !== true) throw new Error("the page did not hydrate");
    const assetUrls = await js(
      `[...new Set([...document.querySelectorAll("link[href], script[src], img[src]")].map((e) => e.href || e.src).filter((u) => new URL(u).origin === location.origin && new URL(u).pathname.startsWith("/assets/")))]`,
      5_000,
    );
    if (!isStringArray(assetUrls) || assetUrls.length === 0) throw new Error("the page links no /assets/* files");
    // The page's clock is coarsened (100 µs in a page that is not cross-origin isolated); the
    // smallest step it shows is stored with the result, since latencies are quantized to it.
    const timerResolutionMs = await js(
      `(() => { let min = Infinity; let last = performance.now(); const end = last + 20; while (last < end) { const now = performance.now(); if (now > last) { min = Math.min(min, now - last); last = now; } } return Math.round(min * 1e6) / 1e6; })()`,
      5_000,
    );

    const pids = { main: process.pid, renderer: win.webContents.getOSProcessId() };
    const runPage = async (spec: PageCaseSpec): Promise<PageCaseResult> => {
      const value = await js(`(${runPageCase.toString()})(${JSON.stringify(spec)})`, spec.durationMs + 60_000);
      if (!isPageCaseResult(value)) throw new Error(`unexpected page result: ${JSON.stringify(value)}`);
      return value;
    };
    const snapshot = async (): Promise<Snapshot> => {
      const utility = await procFromUtility(deps);
      return {
        at: performance.now(),
        mainCpu: process.cpuUsage(),
        metrics: deps.getAppMetrics(),
        utility,
        client: deps.clientStats(),
      };
    };

    const results: BenchCaseResult[] = [];
    for (const c of config.cases) {
      const op: PageOp = c.op.kind === "assets" ? { kind: "assets", urls: assetUrls } : c.op;
      const base = { op, concurrency: c.concurrency, ...(c.background ? { background: c.background } : {}) };
      if (config.warmupMs > 0) await runPage({ ...base, durationMs: config.warmupMs, record: false });

      const peaks = perRole(() => 0);
      const sample = (metrics: ProcessMetric[]) => {
        const byRole = perRole(() => 0);
        for (const m of metrics) byRole[processRole(m, pids)] += m.memory.workingSetSize;
        for (const role of ROLES) peaks[role] = Math.max(peaks[role], byRole[role]);
      };
      const before = await snapshot();
      sample(before.metrics);
      const sampler = setInterval(() => sample(deps.getAppMetrics()), 100);
      let page: PageCaseResult;
      try {
        page = await runPage({ ...base, durationMs: config.measureMs, record: true });
      } finally {
        clearInterval(sampler);
      }
      const after = await snapshot();
      sample(after.metrics);
      results.push(caseResult(c.name, base, before, after, page, peaks, pids));
      const fg = page.foreground;
      log.info(
        { case: c.name, ops: fg.ops, errors: fg.errors, p50Ms: fg.latency?.p50Ms, p99Ms: fg.latency?.p99Ms },
        "bench case finished",
      );
      if (fg.errors > 0 || (page.background?.errors ?? 0) > 0) {
        throw new Error(`case ${c.name} had errors: ${fg.firstError ?? page.background?.firstError}`);
      }
    }

    const result = {
      ok: true,
      label: config.label,
      ackCoalesce: deps.ackCoalesce,
      warmupMs: config.warmupMs,
      measureMs: config.measureMs,
      assets: assetUrls.length,
      rendererTimerResolutionMs: typeof timerResolutionMs === "number" ? timerResolutionMs : undefined,
      startedAt: new Date(started).toISOString(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      cases: results,
    };
    process.stdout.write(`BENCH_RESULT ${JSON.stringify(result)}\n`);
    await deps.exit(0);
  } catch (err) {
    log.error({ err }, "bench failed");
    process.stdout.write(
      `BENCH_RESULT ${JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })}\n`,
    );
    await deps.exit(1);
  }
}

async function procFromUtility(deps: BenchDeps): Promise<BenchProc> {
  const response = await deps.utilityFetch(new Request(`${deps.internalOrigin}/__bench/proc`));
  if (!response.ok) throw new Error(`/__bench/proc: HTTP ${response.status} (is DESKTOP_BENCH reaching the utility?)`);
  const proc: unknown = await response.json();
  if (!isBenchProc(proc)) throw new Error("/__bench/proc: unexpected answer");
  return proc;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isBenchProc(value: unknown): value is BenchProc {
  return (
    isRecord(value) &&
    isRecord(value.cpu) &&
    typeof value.cpu.user === "number" &&
    typeof value.cpu.system === "number" &&
    isRecord(value.memory) &&
    typeof value.memory.rss === "number"
  );
}

function isLoopResult(value: unknown): value is PageCaseResult["foreground"] {
  return (
    isRecord(value) &&
    typeof value.ops === "number" &&
    typeof value.bytes === "number" &&
    typeof value.errors === "number" &&
    typeof value.wallMs === "number"
  );
}

function isPageCaseResult(value: unknown): value is PageCaseResult {
  return (
    isRecord(value) &&
    isLoopResult(value.foreground) &&
    (value.background === undefined || value.background === null || isLoopResult(value.background))
  );
}

function caseResult(
  name: string,
  spec: BenchCaseResult["spec"],
  before: Snapshot,
  after: Snapshot,
  page: PageCaseResult,
  peaks: Record<ProcessRole, number>,
  pids: { main: number; renderer: number },
): BenchCaseResult {
  const wallMs = after.at - before.at;
  const appCpu = (metrics: ProcessMetric[]) => {
    const out = perRole(() => 0);
    for (const m of metrics) out[processRole(m, pids)] += (m.cpu.cumulativeCPUUsage ?? 0) * 1000;
    return out;
  };
  // Per role, the sum over its processes at each end: a process that started mid-window counts its
  // whole life, one that exited mid-window drops out (only "other" has such processes in practice).
  const appBefore = appCpu(before.metrics);
  const appAfter = appCpu(after.metrics);
  const appMetricsCpuMs = perRole((r) => round(appAfter[r] - appBefore[r]));
  const cpuMs: Record<ProcessRole, number> = {
    main: cpuDeltaMs(before.mainCpu, after.mainCpu),
    utility:
      before.utility && after.utility ? cpuDeltaMs(before.utility.cpu, after.utility.cpu) : appMetricsCpuMs.utility,
    renderer: appMetricsCpuMs.renderer,
    other: appMetricsCpuMs.other,
  };
  const usage = perRole((r): RoleUsage => ({
    cpuMs: round(cpuMs[r]),
    cpuUtil: round(cpuMs[r] / wallMs),
    peakWorkingSetMiB: round(peaks[r] / 1024),
  }));
  const fg = page.foreground;
  const perSec = (loop: { ops: number; bytes: number; wallMs: number }) => ({
    opsPerSec: round((loop.ops * 1000) / loop.wallMs),
    mibPerSec: round((loop.bytes * 1000) / loop.wallMs / MiB),
  });
  const mem = after.utility?.memory;
  return {
    name,
    spec,
    wallMs: round(wallMs),
    page,
    ...perSec(fg),
    ...(page.background ? { background: perSec(page.background) } : {}),
    usage,
    appMetricsCpuMs,
    ...(mem
      ? {
          utilityMemoryMiB: {
            rss: round(mem.rss / MiB),
            heapUsed: round(mem.heapUsed / MiB),
            external: round(mem.external / MiB),
            arrayBuffers: round(mem.arrayBuffers / MiB),
          },
        }
      : {}),
    portStats: {
      client: after.client ? counterDelta(before.client, after.client, STAT_GAUGES) : undefined,
      server: after.utility?.stats ? counterDelta(before.utility?.stats, after.utility.stats, STAT_GAUGES) : undefined,
    },
  };
}

function cpuDeltaMs(before: NodeJS.CpuUsage, after: NodeJS.CpuUsage): number {
  return (after.user - before.user + after.system - before.system) / 1000;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
