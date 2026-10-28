import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

import {
  type BenchOptions,
  LINKS,
  type LinkName,
  type RunConfig,
  type Suite,
  SUITES,
  supports,
  type Variant,
  type WsReceiver,
} from "./config.ts";
import { environment } from "./environment.ts";
import {
  expect,
  isBenchOptions,
  isLinkName,
  isRunResult,
  isSuite,
  isVariant,
  isWsReceiver,
  parseJson,
} from "./guards.ts";
import type { StreamResult } from "./producer.ts";
import type { ResultFile, RunResult } from "./result.ts";
import { DEFAULT_SEND_BUDGET, type SendBudget } from "./scheduler.ts";
import { CASES, findCase } from "./workload.ts";

/**
 * `pnpm bench:transport --suite smoke|full [--link <name>] [--case <name>] [--variant raw|package]
 * [--seed n] [--repeat n] [--window bytes] [--send-budget bytes,ms] [--options json | --options-file file.json]
 * [--ws-receiver pausable|standard] [--label text]
 * [--out results/file.json]`. Every (link, case, variant)
 * runs in a fresh Node process so one run's heap, timers and JIT state never leak into the next.
 */
interface Args {
  suite: Suite;
  links: LinkName[];
  cases: string[];
  variants: Variant[];
  seed: number;
  repeat: number;
  windowBytes: number;
  sendBudget: SendBudget;
  options: BenchOptions;
  wsReceiver?: WsReceiver;
  label?: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const suite = expect(get("suite") ?? "smoke", isSuite, `suite (known: ${Object.keys(SUITES).join(", ")})`);
  const link = get("link");
  const links: LinkName[] = link
    ? link.split(",").map((l) => expect(l, isLinkName, `link (known: ${LINKS.join(", ")})`))
    : [...LINKS];
  const caseArg = get("case");
  const cases = caseArg ? caseArg.split(",").map((c) => findCase(c).name) : CASES.map((c) => c.name);
  const wsReceiverArg = get("ws-receiver");
  const variant = get("variant");
  const variants: Variant[] = variant
    ? variant.split(",").map((v) => expect(v, isVariant, "variant (raw or package)"))
    : ["raw", "package"];
  return {
    suite,
    links,
    cases,
    variants,
    seed: Number(get("seed") ?? 20261027),
    repeat: Number(get("repeat") ?? 1),
    windowBytes: Number(get("window") ?? 1024 * 1024),
    sendBudget: parseSendBudget(get("send-budget")),
    options: parseOptions(get("options"), get("options-file")),
    wsReceiver:
      wsReceiverArg === undefined
        ? undefined
        : expect(wsReceiverArg, isWsReceiver, "ws receiver (pausable or standard)"),
    label: get("label"),
    out: get("out") ?? `results/${suite}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  };
}

function parseSendBudget(text: string | undefined): SendBudget {
  if (text === undefined) return DEFAULT_SEND_BUDGET;
  const [bytes, ms] = text.split(",").map(Number);
  if (bytes === undefined || ms === undefined || !isPositive(bytes) || !isPositive(ms)) {
    // Finite, since the config reaches the run processes as JSON (Infinity would become null).
    throw new Error(`--send-budget takes "bytes,ms", both finite and positive: ${text}`);
  }
  return { bytes, ms };
}

function isPositive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

function parseOptions(inline: string | undefined, file: string | undefined): BenchOptions {
  if (inline !== undefined && file !== undefined) throw new Error("pass --options or --options-file, not both");
  const text = inline ?? (file === undefined ? "{}" : readFileSync(file, "utf8"));
  return expect(parseJson(text), isBenchOptions, "options ({ channel?, portFetch?, relay? }, each an object)");
}

/**
 * Node flags for every run process: this process's own, plus the `@repo/source` export condition so
 * the packages are loaded from `src/` as everywhere else in the workspace. Without it Node takes
 * their `default` export, `dist/`, which is whatever was built last (stale, or missing).
 */
const RUN_EXEC_ARGV = process.execArgv.includes("--conditions=@repo/source")
  ? process.execArgv
  : [...process.execArgv, "--conditions=@repo/source"];

function runOne(config: RunConfig, repeat: number): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [...RUN_EXEC_ARGV, new URL("./run-one.ts", import.meta.url).pathname, JSON.stringify(config), String(repeat)],
      {
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    let result: RunResult | undefined;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (line.startsWith("RESULT ")) result = expect(parseJson(line.slice(7)), isRunResult, "run result");
      else process.stderr.write(`${line}\n`);
    });
    child.once("exit", (code) => {
      if (!result) reject(new Error(`run exited with ${code} without a result`));
      else resolvePromise(result);
    });
  });
}

function summarize(r: RunResult): string {
  if (r.error) return `ERROR ${r.error.split("\n")[0]}`;
  if (r.fetch) {
    const f = r.fetch;
    return `${f.requests.completed} req, ttfb p50 ${f.ttfbMs.p50Ms} p99 ${f.ttfbMs.p99Ms} ms, complete p50 ${f.completeMs.p50Ms} ms, ${mib(f.goodput.bytesPerSec)} MiB/s, thread cpu ${r.sender.threadCpu?.utilization ?? "-"}, process cpu ${r.sender.cpu.utilization}${f.cancel ? `, cancel p50 ${f.cancel.cancelToSettledMs.p50Ms} ms` : ""}`;
  }
  const s = r.stream;
  if (!s) return "no result";
  const lat = s.stream?.fromIntended;
  const rpc = s.rpc?.fromIntended;
  const closed = s.closed
    ? `CLOSED ${s.closed.code ?? "-"}${s.closed.reason ? ` (${s.closed.reason})` : ""} in ${s.closed.phase} after ${s.closed.afterMs} ms; `
    : "";
  return `${closed}${s.goodput.messagesPerSec} msg/s ${mib(s.goodput.bytesPerSec)} MiB/s, lat p50 ${lat?.p50Ms ?? "-"} p99 ${lat?.p99Ms ?? "-"} ms, late ${s.stream?.late ?? 0}, yields ${s.stream?.yields ?? "-"} max burst ${s.stream?.maxBurstMs ?? "-"} ms${rpc ? `, rpc p50 ${rpc.p50Ms} p99 ${rpc.p99Ms} ms${s.rpc?.censored ? ` (${s.rpc.censored} censored)` : ""}` : ""}, sender thread cpu ${r.sender.threadCpu?.utilization ?? "-"}, peer thread cpu ${s.peer.metrics?.threadCpu?.utilization ?? "-"}, process cpu ${r.sender.cpu.utilization}${s.cancel ? `, cancel ${s.cancel.closeToClosedMs} ms` : ""}${backlogSummary(s)}`;
}

/** The `consumer` cases' backlog, recovery and cancel release, in MiB. */
function backlogSummary(s: StreamResult): string {
  const parts: string[] = [];
  const b = s.backlog;
  if (b) {
    parts.push(
      `e2e backlog max ${mib(b.maxEndToEndBytes)} end ${mib(b.endEndToEndBytes)} MiB, in flight max ${mib(b.maxInFlightBytes)} end ${mib(b.endInFlightBytes)} MiB, abandoned ${b.abandonedFrames}`,
    );
    if (b.recovery)
      parts.push(
        `recovery cleared after ${b.recovery.clearedAfterMs ?? "never"} ms, then ${mib(b.recovery.consumedBytesPerSecAfter ?? 0)} MiB/s`,
      );
  }
  const c = s.peer.consumer;
  if (c) {
    parts.push(`peer queue max ${mib(c.maxQueuedBytes)} end ${mib(c.endQueuedBytes)} MiB`);
    if (c.recovery) parts.push(`peer queue empty ${c.recovery.queueEmptyAfterMs ?? "never"} ms after recovery`);
  }
  const m = s.peer.metrics?.memory;
  if (m && c)
    parts.push(
      `peer heap ${mib(m.baseline.heapUsed)}→${mib(m.last.heapUsed)} (max ${mib(m.peak.heapUsed)}) MiB, rss max ${mib(m.peak.rss)} MiB`,
    );
  const r = s.release;
  if (r) {
    parts.push(
      `peer saw close after ${r.peerSawCloseAfterMs} ms, consumed ${r.consumedAfterCancel ?? "-"} after cancel, dropped ${r.droppedAtPeer}, never delivered ${r.neverDelivered}, peer arrayBuffers ${mib(r.peerArrayBuffersAtClose)}→${mib(r.peerArrayBuffersAfter)} MiB`,
    );
  } else if (s.peerClose) {
    parts.push(`peer closed ${s.peerClose.code ?? "-"}, dropped ${s.peerClose.droppedAtClose.frames} frames`);
  }
  return parts.length > 0 ? `; ${parts.join(", ")}` : "";
}

function mib(bytesPerSec: number): number {
  return Math.round((bytesPerSec / 1048576) * 10) / 10;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { warmupMs, measureMs } = SUITES[args.suite];
  const file: ResultFile = { environment: environment(), label: args.label, options: args.options, runs: [] };
  const out = resolve(process.cwd(), args.out);
  mkdirSync(dirname(out), { recursive: true });
  for (const link of args.links) {
    for (const caseName of args.cases) {
      for (const variant of args.variants) {
        const config: RunConfig = {
          link,
          variant,
          suite: args.suite,
          seed: args.seed,
          caseSpec: findCase(caseName),
          windowBytes: args.windowBytes,
          sendBudget: args.sendBudget,
          warmupMs,
          measureMs,
          options: args.options,
          wsReceiver: args.wsReceiver,
        };
        const reason = supports(config);
        if (reason) {
          process.stdout.write(`skip  ${link}/${caseName}/${variant}: ${reason}\n`);
          continue;
        }
        for (let repeat = 0; repeat < args.repeat; repeat++) {
          const result = await runOne(config, repeat);
          file.runs.push(result);
          process.stdout.write(`${link}/${caseName}/${variant}#${repeat}: ${summarize(result)}\n`);
          writeFileSync(out, JSON.stringify(file, null, 2));
        }
      }
    }
  }
  process.stdout.write(`wrote ${out}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
