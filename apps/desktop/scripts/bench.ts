// Real-app transport benchmark runner (ABBA rounds of ack coalescing off/on over fresh test launches).
// Runs on Node directly (type stripping); see apps/desktop/README.md.
//   node scripts/bench.ts [run] [--rounds 5] [--measure-ms 10000] [--warmup-ms 2000]
//                         [--cases api-c1,...] [--modes off,on] [--label text] [--out file.jsonl]
//                         [--app path/to/packaged/executable]
//   node scripts/bench.ts compare <file.jsonl>...
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { getCurrentFuseWire } from "@electron/fuses";

import type { BenchCaseResult } from "../src/diagnostics/bench/bench";
import { monitorDesktopChild } from "./child-run.ts";
import { describeFuses, fuseReadings } from "./fuses.ts";
import {
  appProcesses,
  checkLaunchInputs,
  desktopDir,
  freshUserDataDir,
  type LaunchLocation,
  launchLocation,
  launchSpec,
  type LaunchTarget,
  removeUserDataDir,
} from "./launch.ts";

type Mode = "off" | "on";

/** What a run was measured on; runs are comparable only when theirs are equal. */
export interface RunMarker {
  target: LaunchTarget;
  /** The fuses of the binary that ran, as scripts/fuses.ts describes them (`name=value ...`). */
  fuses: string;
}

interface RunRecord extends Partial<RunMarker> {
  round: number;
  mode: Mode;
  exitCode: number | null;
  durationMs: number;
  result?: { ok: boolean; error?: string; cases?: BenchCaseResult[]; [key: string]: unknown };
}

function isMode(value: string): value is Mode {
  return value === "off" || value === "on";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A BENCH_RESULT payload, checked as far as this script reads it. */
function isBenchResult(value: unknown): value is NonNullable<RunRecord["result"]> {
  return isRecord(value) && typeof value.ok === "boolean" && (value.cases === undefined || Array.isArray(value.cases));
}

function isRunRecord(value: unknown): value is RunRecord {
  return (
    isRecord(value) &&
    typeof value.mode === "string" &&
    isMode(value.mode) &&
    (value.target === undefined || value.target === "unpackaged" || value.target === "packaged") &&
    (value.fuses === undefined || typeof value.fuses === "string") &&
    (value.result === undefined || isBenchResult(value.result))
  );
}

/** A record's marker as one string, or undefined for a record written before markers existed. */
function markerKey(record: Partial<RunMarker>): string | undefined {
  return record.target === undefined || record.fuses === undefined ? undefined : `${record.target}, ${record.fuses}`;
}

/**
 * Throws unless every record of `files` (records per file) carries the same marker, and `expected`
 * when given: results from another target or from a binary with other fuses must not be merged into
 * one file or compared. Records written before markers existed are refused too: nothing says what
 * they were measured on.
 */
export function checkRunMarkers(files: ReadonlyMap<string, readonly Partial<RunMarker>[]>, expected?: RunMarker): void {
  const seen = new Map<string, string>();
  if (expected) seen.set(markerKey(expected)!, "this run");
  for (const [file, records] of files) {
    for (const record of records) {
      const key = markerKey(record);
      if (key === undefined) {
        throw new Error(
          `${file} holds runs without a target and fuse marker (written by an older bench): ` +
            "they cannot be compared with anything; measure again",
        );
      }
      if (!seen.has(key)) seen.set(key, file);
    }
  }
  if (seen.size > 1) {
    throw new Error(
      "Refusing to merge or compare runs measured on different targets or fuses:\n" +
        [...seen].map(([key, where]) => `  ${where}: ${key}`).join("\n"),
    );
  }
}

function readRecords(file: string): RunRecord[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line): unknown => JSON.parse(line))
    .filter(isRunRecord);
}

/**
 * What a run launches (scripts/launch.ts): this checkout's Electron on the unpackaged test bundles,
 * or with `--app <executable>` a packaged test-profile app (release builds do not contain the benchmark).
 */
let target: LaunchLocation | undefined;
/** `--app`, for `launchSpec` at each run. */
let app: string | undefined;

const isWindows = process.platform === "win32";

function runProcesses(): number[] {
  if (!target) throw new Error("no target yet");
  return appProcesses(target.command, target.processDir);
}

function parseArgs(argv: string[]) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("--") ? args.shift()! : "run";
  const options = new Map<string, string>();
  const positional: string[] = [];
  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg.startsWith("--")) {
      const value = args.shift();
      if (value === undefined) throw new Error(`${arg} needs a value`);
      options.set(arg.slice(2), value);
    } else positional.push(arg);
  }
  return { command, options, positional };
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`--${name} expects a non-negative integer`);
  return n;
}

let current: ReturnType<typeof monitorDesktopChild> | undefined;
/** The user data directories of runs not yet cleaned up, removed on any exit. */
const userDataDirs = new Set<string>();

function cleanup(): void {
  current?.kill();
  for (const directory of userDataDirs) removeUserDataDir(directory);
  userDataDirs.clear();
}

let interruptedExit: number | undefined;
function interrupt(code: number): void {
  interruptedExit ??= code;
  process.exitCode = interruptedExit;
  if (current) {
    current.abort(new Error("Bench interrupted"));
    return;
  }
  cleanup();
  process.exit(interruptedExit);
}

async function runOnce(
  round: number,
  mode: Mode,
  env: Record<string, string>,
  timeoutMs: number,
  marker: RunMarker,
): Promise<RunRecord> {
  if (interruptedExit !== undefined) throw new Error("Bench interrupted");
  const started = performance.now();
  // A user data directory of its own: no single-instance clash with a running app, no state from
  // another run, nothing written to the installed app's.
  const userDataDir = freshUserDataDir("bench");
  userDataDirs.add(userDataDir);
  const spec = launchSpec(target!.target, target!.profile, { executable: app, userDataDir });
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...spec.env,
    ...env,
    DESKTOP_PORT_ACK_COALESCE: mode === "on" ? "1" : "0",
  };
  for (const key of [
    "DESKTOP_SMOKE",
    "DESKTOP_SMOKE_LAYOUT",
    "DESKTOP_BOOT_PROFILE",
    "DESKTOP_SMOKE_SCREENSHOT",
    "ELECTRON_RUN_AS_NODE",
  ])
    delete childEnv[key];
  const { command, args, cwd } = spec;
  const spawnedAt = Date.now();
  const child = spawn(command, args, {
    cwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: !isWindows,
  });
  let result: RunRecord["result"];
  const monitor = monitorDesktopChild(child, spec, spawnedAt, {
    userDataDir,
    onLine(line) {
      if (line.startsWith("BENCH_RESULT ")) {
        const parsed: unknown = JSON.parse(line.slice("BENCH_RESULT ".length));
        if (!isBenchResult(parsed)) throw new Error("Invalid BENCH_RESULT");
        result = parsed;
      } else if (/"level":"(warn|error)"/.test(line)) process.stderr.write(`  [app] ${line}\n`);
    },
  });
  current = monitor;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    // Chromium's own noise (e.g. GPU or task policy lines) is not ours; keep it for diagnosis only.
    if (process.env.BENCH_VERBOSE === "1") process.stderr.write(chunk);
  });
  const timer = setTimeout(() => monitor.abort(new Error(`Bench timed out after ${timeoutMs} ms`)), timeoutMs);
  try {
    const exitCode = await monitor.finished;
    if (readdirSync(userDataDir).length === 0)
      throw new Error(`run ${round}/${mode} left nothing in its user data directory ${userDataDir}`);
    return { ...marker, round, mode, exitCode, durationMs: Math.round(performance.now() - started), result };
  } finally {
    clearTimeout(timer);
    try {
      const killed = await monitor.reap();
      if (killed.length) process.stderr.write(`  stopped lingering helpers of this run: ${killed.join(", ")}\n`);
    } finally {
      current = undefined;
      userDataDirs.delete(userDataDir);
    }
    // A failed reap leaves this profile in place for any process still using it.
    removeUserDataDir(userDataDir);
  }
}

async function run(options: Map<string, string>): Promise<void> {
  const rounds = positiveInt(options.get("rounds"), 3, "rounds");
  const measureMs = positiveInt(options.get("measure-ms"), 5000, "measure-ms");
  const warmupMs = positiveInt(options.get("warmup-ms"), Math.min(2000, Math.max(500, measureMs / 5)), "warmup-ms");
  const cases = options.get("cases");
  const modes = (options.get("modes") ?? "off,on").split(",").map((m) => {
    if (!isMode(m)) throw new Error(`--modes expects off and/or on, got "${m}"`);
    return m;
  });
  const out = resolve(
    options.get("out") ??
      join(desktopDir, "bench-results", `bench-${new Date().toISOString().replaceAll(":", "-")}.jsonl`),
  );

  app = options.get("app");
  target = launchLocation(app === undefined ? "unpackaged" : "packaged", "test", { executable: app });
  // The executable exists; the unpackaged test bundles match the web build (a packaged app carries
  // its own, and must have the test profile's fuses).
  await checkLaunchInputs(target);
  // What these runs are measured on, recorded with each of them; a file of runs on anything else is
  // not appended to.
  const marker: RunMarker = {
    target: target.target,
    fuses: describeFuses(fuseReadings(await getCurrentFuseWire(target.command))),
  };
  if (existsSync(out)) checkRunMarkers(new Map([[out, readRecords(out)]]), marker);
  const already = runProcesses();
  if (already.length > 0) {
    throw new Error(`The app under test is already running (pids ${already.join(", ")}); quit it first`);
  }
  mkdirSync(dirname(out), { recursive: true });

  const caseCount = cases ? cases.split(",").length : 8;
  const timeoutMs = caseCount * (warmupMs + measureMs) * 2 + 120_000;
  const env: Record<string, string> = {
    DESKTOP_BENCH: "1",
    DESKTOP_BENCH_MEASURE_MS: String(measureMs),
    DESKTOP_BENCH_WARMUP_MS: String(warmupMs),
    ...(cases ? { DESKTOP_BENCH_CASES: cases } : {}),
    ...(options.get("label") ? { DESKTOP_BENCH_LABEL: options.get("label")! } : {}),
  };
  process.stdout.write(
    `bench: ${rounds} round(s) × [${modes.join(", ")}], warmup ${warmupMs} ms, measure ${measureMs} ms per case → ${out}\n` +
      `bench: ${marker.target} target, fuses ${marker.fuses}\n`,
  );
  let failures = 0;
  try {
    for (let round = 0; round < rounds; round++) {
      // ABBA: alternate which mode goes first, so drift (thermal, caches) does not favour one.
      const order = round % 2 === 0 ? modes : modes.toReversed();
      for (const mode of order) {
        process.stdout.write(`round ${round + 1}/${rounds} ack coalescing ${mode} … `);
        const record = await runOnce(round, mode, env, timeoutMs, marker);
        appendFileSync(out, JSON.stringify(record) + "\n");
        const ok = record.exitCode === 0 && record.result?.ok === true;
        if (!ok) failures++;
        process.stdout.write(
          ok
            ? `ok (${record.durationMs} ms)\n`
            : `FAILED (exit ${record.exitCode}): ${record.result?.error ?? "no result"}\n`,
        );
      }
    }
  } finally {
    let leftover = runProcesses();
    const until = Date.now() + 5000;
    while (leftover.length && Date.now() < until) {
      await new Promise((done) => setTimeout(done, 100));
      leftover = runProcesses();
    }
    if (leftover.length > 0) {
      process.stderr.write(`Electron processes still running after the bench: ${leftover.join(", ")}\n`);
      failures++;
    } else {
      process.stdout.write(`no Electron process left running (${isWindows ? "process list" : "pgrep"})\n`);
    }
  }
  process.stdout.write("\n");
  compare([out]);
  if (failures > 0) {
    process.stderr.write(`${failures} run(s) failed\n`);
    process.exitCode = 1;
  }
}

interface Metric {
  label: string;
  get: (c: BenchCaseResult) => number | undefined;
  /** Whether a higher value is better (for the sign of the verdict). */
  higherIsBetter: boolean;
}

const perOpUs = (ms: number, ops: number) => (ops > 0 ? (ms * 1000) / ops : undefined);

const METRICS: Metric[] = [
  { label: "ops/s", get: (c) => c.opsPerSec, higherIsBetter: true },
  { label: "MiB/s", get: (c) => c.mibPerSec, higherIsBetter: true },
  { label: "mean ms", get: (c) => c.page.foreground.latency?.meanMs, higherIsBetter: false },
  { label: "p50 ms", get: (c) => c.page.foreground.latency?.p50Ms, higherIsBetter: false },
  { label: "p99 ms", get: (c) => c.page.foreground.latency?.p99Ms, higherIsBetter: false },
  { label: "p999 ms", get: (c) => c.page.foreground.latency?.p999Ms, higherIsBetter: false },
  { label: "bg MiB/s", get: (c) => c.background?.mibPerSec, higherIsBetter: true },
  { label: "main cpu util", get: (c) => c.usage.main.cpuUtil, higherIsBetter: false },
  { label: "utility cpu util", get: (c) => c.usage.utility.cpuUtil, higherIsBetter: false },
  { label: "renderer cpu util", get: (c) => c.usage.renderer.cpuUtil, higherIsBetter: false },
  { label: "other cpu util", get: (c) => c.usage.other.cpuUtil, higherIsBetter: false },
  { label: "main cpu µs/op", get: (c) => perOpUs(c.usage.main.cpuMs, c.page.foreground.ops), higherIsBetter: false },
  {
    label: "utility cpu µs/op",
    get: (c) => perOpUs(c.usage.utility.cpuMs, c.page.foreground.ops),
    higherIsBetter: false,
  },
  { label: "main peak MiB", get: (c) => c.usage.main.peakWorkingSetMiB, higherIsBetter: false },
  { label: "utility peak MiB", get: (c) => c.usage.utility.peakWorkingSetMiB, higherIsBetter: false },
  { label: "renderer peak MiB", get: (c) => c.usage.renderer.peakWorkingSetMiB, higherIsBetter: false },
  {
    label: "acks sent (main)",
    get: (c) => nested(c.portStats.client, "framesSent", "ack"),
    higherIsBetter: false,
  },
  {
    label: "acks sent (utility)",
    get: (c) => nested(c.portStats.server, "framesSent", "ack"),
    higherIsBetter: false,
  },
];

function nested(value: unknown, ...keys: string[]): number | undefined {
  let at = value;
  for (const key of keys) {
    if (typeof at !== "object" || at === null) return undefined;
    at = Reflect.get(at, key);
  }
  return typeof at === "number" ? at : undefined;
}

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmt(n: number): string {
  const abs = Math.abs(n);
  return abs >= 1000 ? n.toFixed(0) : abs >= 10 ? n.toFixed(1) : abs >= 1 ? n.toFixed(2) : n.toFixed(3);
}

function compare(files: string[]): void {
  const byFile = new Map(files.map((file) => [file, readRecords(file)]));
  checkRunMarkers(byFile);
  const records: RunRecord[] = [...byFile.values()].flat();
  const good = records.filter((r) => r.exitCode === 0 && r.result?.ok && r.result.cases);
  if (good.length === 0) {
    process.stdout.write("no successful runs to compare\n");
    return;
  }
  const byCase = new Map<string, Map<Mode, BenchCaseResult[]>>();
  for (const record of good) {
    for (const c of record.result!.cases!) {
      const modes = byCase.get(c.name) ?? new Map<Mode, BenchCaseResult[]>();
      byCase.set(c.name, modes);
      modes.set(record.mode, [...(modes.get(record.mode) ?? []), c]);
    }
  }
  const resolution = good.map((r) => r.result!.rendererTimerResolutionMs).find((v) => typeof v === "number");
  process.stdout.write(
    "Medians over runs, [min–max] in brackets; Δ is on vs off; '~' marks overlapping ranges (no clear difference).\n" +
      `Latencies are on the renderer clock, quantized to ${typeof resolution === "number" ? `${resolution} ms` : "its resolution"}; compare means and counts where steps dominate.\n`,
  );
  for (const [name, modes] of byCase) {
    const off = modes.get("off") ?? [];
    const on = modes.get("on") ?? [];
    process.stdout.write(`\n${name}  (runs: off ${off.length}, on ${on.length})\n`);
    process.stdout.write(`  ${"metric".padEnd(20)}${"off".padEnd(28)}${"on".padEnd(28)}Δ\n`);
    for (const metric of METRICS) {
      const values = (list: BenchCaseResult[]) =>
        list.map(metric.get).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      const a = values(off);
      const b = values(on);
      if (a.length === 0 && b.length === 0) continue;
      const cell = (v: number[]) =>
        v.length === 0 ? "-" : `${fmt(median(v))} [${fmt(Math.min(...v))}–${fmt(Math.max(...v))}]`;
      let delta = "";
      if (a.length > 0 && b.length > 0) {
        const ma = median(a);
        const mb = median(b);
        const pct = ma === 0 ? (mb === 0 ? 0 : Infinity) : ((mb - ma) / Math.abs(ma)) * 100;
        const overlap = Math.max(...a) >= Math.min(...b) && Math.max(...b) >= Math.min(...a);
        const better = pct === 0 ? "" : pct > 0 === metric.higherIsBetter ? " better" : " worse";
        delta = `${pct >= 0 ? "+" : ""}${Number.isFinite(pct) ? pct.toFixed(1) : "∞"}%${overlap ? " ~" : better}`;
      }
      process.stdout.write(`  ${metric.label.padEnd(20)}${cell(a).padEnd(28)}${cell(b).padEnd(28)}${delta}\n`);
    }
  }
}

async function main() {
  process.on("SIGINT", () => interrupt(130));
  process.on("SIGTERM", () => interrupt(143));
  process.on("SIGHUP", () => interrupt(129));
  // Piped into `head` and the like: stop quietly when the reader goes away.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") return interrupt(0);
    throw err;
  });

  const { command, options, positional } = parseArgs(process.argv.slice(2));
  try {
    if (command === "run") await run(options);
    else if (command === "compare") {
      if (positional.length === 0) throw new Error("compare needs one or more .jsonl files");
      compare(positional);
    } else throw new Error(`unknown command "${command}": expected run or compare`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    cleanup();
    process.exitCode = interruptedExit ?? 1;
  }
}

if (import.meta.main) void main();
