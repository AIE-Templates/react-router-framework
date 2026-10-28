// The real-app transport benchmark runner: launches the built, unpackaged app (`electron .`, as
// `pnpm --filter desktop start` does) with DESKTOP_BENCH=1 in a fresh process per run, alternating
// ack coalescing off and on (ABBA order across rounds), collects each run's BENCH_RESULT line into
// a JSON Lines file and prints the comparison. Builds nothing: run `pnpm build:desktop` first, or
// pass `--app` with a packaged test-profile executable (then the script needs only Node, no checkout).
// Runs on Node directly (type stripping). See README, "Real-app benchmark".
//
//   node scripts/bench.ts [run] [--rounds 5] [--measure-ms 10000] [--warmup-ms 2000]
//                         [--cases api-c1,...] [--modes off,on] [--label text] [--out file.jsonl]
//                         [--app path/to/packaged/executable]
//   node scripts/bench.ts compare <file.jsonl>...
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import type { BenchCaseResult } from "../src/main/bench.ts";

const desktopDir = resolve(import.meta.dirname, "..");

type Mode = "off" | "on";

interface RunRecord {
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
    (value.result === undefined || isBenchResult(value.result))
  );
}

function electronBinary(): string {
  const require = createRequire(import.meta.url);
  const packageDir = dirname(require.resolve("electron/package.json"));
  return join(packageDir, "dist", readFileSync(join(packageDir, "path.txt"), "utf8").trim());
}

/**
 * What a run launches: this checkout's Electron on apps/desktop (the built, unpackaged app), or with
 * `--app <executable>` a packaged test-profile app (the release profile ignores DESKTOP_BENCH). `dist`
 * is the directory every process of a run has its executable under.
 */
interface Target {
  command: string;
  args: string[];
  cwd: string;
  dist: string;
}
let target: Target | undefined;

function resolveTarget(app: string | undefined): Target {
  if (app === undefined) {
    const command = electronBinary();
    return { command, args: ["."], cwd: desktopDir, dist: dirname(command) };
  }
  const command = resolve(app);
  if (!existsSync(command)) throw new Error(`--app ${command} does not exist`);
  // A macOS bundle's helpers live under Contents/Frameworks, beside Contents/MacOS.
  const bundle = command.lastIndexOf(".app/Contents/MacOS/");
  return {
    command,
    args: [],
    cwd: dirname(command),
    dist: bundle >= 0 ? command.slice(0, bundle + 4) : dirname(command),
  };
}

const isWindows = process.platform === "win32";

/**
 * PIDs of the processes of the app under test, this script excluded. POSIX: command lines containing
 * the target's directory followed by a separator (pgrep -f), which covers a macOS bundle's helpers
 * under Contents/Frameworks. Windows: processes whose executable is exactly the target's (every
 * Electron helper there runs the same executable), so nothing else in that directory or in a
 * sibling directory sharing its prefix can match. A failed process listing throws instead of
 * reporting none.
 */
function runProcesses(): number[] {
  if (!target) throw new Error("no target yet");
  let output: string;
  if (isWindows) {
    const exe = target.command.replaceAll("'", "''");
    output = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, '${exe}', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.ProcessId }`,
      ],
      { encoding: "utf8" },
    );
  } else {
    try {
      output = execFileSync("pgrep", ["-f", `${target.dist}/`], { encoding: "utf8" });
    } catch (err) {
      // pgrep exits 1 when nothing matches; anything else is a failure to list.
      if (typeof err === "object" && err !== null && "status" in err && err.status === 1) return [];
      throw err;
    }
  }
  return output
    .split(/\r?\n/)
    .map(Number)
    .filter((pid) => pid > 0 && pid !== process.pid);
}

/**
 * Whether any process of a run is alive. POSIX: its process group (the run is spawned detached, as a
 * group leader). Windows has no process groups to signal; there it is any process running the
 * target's executable, which the bench makes sure is only its own run.
 */
function groupAlive(pgid: number): boolean {
  if (isWindows) return runProcesses().length > 0;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kills a run's processes: its group on POSIX, its process tree and any leftover of this checkout on Windows. */
function killGroup(pgid: number, signal: NodeJS.Signals): void {
  if (isWindows) {
    try {
      execFileSync("taskkill", ["/PID", String(pgid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
    for (const pid of runProcesses()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    return;
  }
  try {
    process.kill(-pgid, signal);
  } catch {}
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

let current: ChildProcess | undefined;
const groups = new Set<number>();

function cleanupAndExit(code: number): never {
  for (const pgid of groups) killGroup(pgid, "SIGKILL");
  process.exit(code);
}
process.on("SIGINT", () => cleanupAndExit(130));
process.on("SIGTERM", () => cleanupAndExit(143));

async function runOnce(round: number, mode: Mode, env: Record<string, string>, timeoutMs: number): Promise<RunRecord> {
  const started = performance.now();
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, DESKTOP_PORT_ACK_COALESCE: mode === "on" ? "1" : "0" };
  for (const key of ["DESKTOP_SMOKE", "DESKTOP_BOOT_PROFILE", "DESKTOP_SMOKE_SCREENSHOT", "ELECTRON_RUN_AS_NODE"])
    delete childEnv[key];
  const { command, args, cwd } = target!;
  const child = spawn(command, args, {
    cwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group: the renderer, GPU and utility processes are killed with it if needed.
    detached: true,
  });
  current = child;
  const pgid = child.pid!;
  groups.add(pgid);
  let result: RunRecord["result"];
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.startsWith("BENCH_RESULT ")) {
        const parsed: unknown = JSON.parse(line.slice("BENCH_RESULT ".length));
        if (isBenchResult(parsed)) result = parsed;
      } else if (/"level":"(warn|error)"/.test(line)) process.stderr.write(`  [app] ${line}\n`);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    // Chromium's own noise (e.g. GPU or task policy lines) is not ours; keep it for diagnosis only.
    if (process.env.BENCH_VERBOSE === "1") process.stderr.write(chunk);
  });
  const timer = setTimeout(() => {
    process.stderr.write(`  run timed out after ${timeoutMs} ms, killing it\n`);
    killGroup(pgid, "SIGKILL");
  }, timeoutMs);
  const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", (code) => resolveExit(code)));
  clearTimeout(timer);
  current = undefined;
  // Electron's helpers exit right after it; give them a moment, then make sure.
  for (let i = 0; i < 50 && groupAlive(pgid); i++) await new Promise((r) => setTimeout(r, 100));
  if (groupAlive(pgid)) {
    process.stderr.write(`  processes of run ${round}/${mode} outlived it, killing them\n`);
    killGroup(pgid, "SIGKILL");
  }
  groups.delete(pgid);
  return { round, mode, exitCode, durationMs: Math.round(performance.now() - started), result };
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

  target = resolveTarget(options.get("app"));
  if (!options.has("app")) {
    for (const file of [".vite/build/main.cjs", ".vite/build/utility.mjs", "../web/build/server/index.js"]) {
      if (!existsSync(join(desktopDir, file))) throw new Error(`${file} is missing: run \`pnpm build:desktop\` first`);
    }
  }
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
    // A user data directory of its own: no single-instance clash with a running app, no shared state.
    DESKTOP_USER_DATA_SUFFIX: "bench",
    NODE_ENV: "production",
    ...(cases ? { DESKTOP_BENCH_CASES: cases } : {}),
    ...(options.get("label") ? { DESKTOP_BENCH_LABEL: options.get("label")! } : {}),
  };
  process.stdout.write(
    `bench: ${rounds} round(s) × [${modes.join(", ")}], warmup ${warmupMs} ms, measure ${measureMs} ms per case → ${out}\n`,
  );
  let failures = 0;
  try {
    for (let round = 0; round < rounds; round++) {
      // ABBA: alternate which mode goes first, so drift (thermal, caches) does not favour one.
      const order = round % 2 === 0 ? modes : modes.toReversed();
      for (const mode of order) {
        process.stdout.write(`round ${round + 1}/${rounds} ack coalescing ${mode} … `);
        const record = await runOnce(round, mode, env, timeoutMs);
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
    const leftover = runProcesses();
    if (leftover.length > 0) {
      process.stderr.write(`Electron processes still running after the bench: ${leftover.join(", ")}; killing them\n`);
      for (const pid of leftover) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
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

// ---- compare -------------------------------------------------------------------------------

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
  const records: RunRecord[] = files.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line): unknown => JSON.parse(line))
      .filter(isRunRecord),
  );
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

// Piped into `head` and the like: stop quietly when the reader goes away.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") cleanupAndExit(0);
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
  if (current?.pid) killGroup(current.pid, "SIGKILL");
  process.exitCode = 1;
}
