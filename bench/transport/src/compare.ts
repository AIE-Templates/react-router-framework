import { readFileSync } from "node:fs";

import { expect, isResultFile, parseJson } from "./guards.ts";
import type { ResultFile, RunResult } from "./result.ts";
import { flattenStats } from "./stats.ts";

/**
 * `pnpm --filter @repo/bench-transport compare <baseline.json> <candidate.json>`: a Markdown table
 * of the main metrics per (link, case, variant), medians over repeats, with the candidate's change.
 * A percentile difference is a comparison of two distributions, not a per-layer cost. A second
 * table lists the packages' `stats()` counters (medians over repeats) that are non-zero on either side.
 */
interface Row {
  key: string;
  metrics: Record<string, number | undefined>;
  stats: Record<string, number>;
}

const METRICS: { name: string; pick: (r: RunResult) => number | undefined; lowerIsBetter: boolean }[] = [
  {
    name: "msg/s",
    pick: (r) => r.stream?.goodput.messagesPerSec ?? r.fetch?.goodput.requestsPerSec,
    lowerIsBetter: false,
  },
  {
    name: "MiB/s",
    pick: (r) => mib(r.stream?.goodput.bytesPerSec ?? r.fetch?.goodput.bytesPerSec),
    lowerIsBetter: false,
  },
  {
    name: "p50 ms",
    pick: (r) => r.stream?.stream?.fromIntended.p50Ms ?? r.fetch?.completeMs.p50Ms,
    lowerIsBetter: true,
  },
  {
    name: "p99 ms",
    pick: (r) => r.stream?.stream?.fromIntended.p99Ms ?? r.fetch?.completeMs.p99Ms,
    lowerIsBetter: true,
  },
  { name: "rpc p99 ms", pick: (r) => r.stream?.rpc?.fromIntended.p99Ms, lowerIsBetter: true },
  { name: "yields", pick: (r) => r.stream?.stream?.yields, lowerIsBetter: true },
  { name: "max burst ms", pick: (r) => r.stream?.stream?.maxBurstMs, lowerIsBetter: true },
  { name: "sender thread cpu", pick: (r) => r.sender.threadCpu?.utilization, lowerIsBetter: true },
  {
    name: "peer thread cpu",
    pick: (r) => r.stream?.peer.metrics?.threadCpu?.utilization ?? r.fetch?.peer.metrics?.threadCpu?.utilization,
    lowerIsBetter: true,
  },
  { name: "sender process cpu", pick: (r) => r.sender.cpu.utilization, lowerIsBetter: true },
  {
    name: "peer process cpu",
    pick: (r) => r.stream?.peer.metrics?.cpu.utilization ?? r.fetch?.peer.metrics?.cpu.utilization,
    lowerIsBetter: true,
  },
  { name: "sender peak rss MiB", pick: (r) => mib(r.sender.memory.peak.rss), lowerIsBetter: true },
  {
    name: "peer peak rss MiB",
    pick: (r) => mib(r.stream?.peer.metrics?.memory.peak.rss ?? r.fetch?.peer.metrics?.memory.peak.rss),
    lowerIsBetter: true,
  },
];

function mib(bytes: number | undefined): number | undefined {
  return bytes === undefined ? undefined : Math.round((bytes / 1048576) * 100) / 100;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function rows(file: ResultFile): Map<string, Row> {
  const groups = new Map<string, RunResult[]>();
  for (const run of file.runs) {
    if (run.error) continue;
    const key = `${run.link}/${run.case}/${run.variant}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const out = new Map<string, Row>();
  for (const [key, runs] of groups) {
    const metrics: Record<string, number | undefined> = {};
    for (const m of METRICS) metrics[m.name] = median(runs.map(m.pick).filter((v): v is number => v !== undefined));
    const flat = runs.map((r) => (r.stats ? flattenStats(r.stats) : {}));
    const stats: Record<string, number> = {};
    for (const path of new Set(flat.flatMap((f) => Object.keys(f)))) {
      const value = median(flat.map((f) => f[path]).filter((v): v is number => v !== undefined));
      if (value !== undefined) stats[path] = value;
    }
    out.set(key, { key, metrics, stats });
  }
  return out;
}

function describe(name: string, file: ResultFile): string {
  const { commit, dirty } = file.environment;
  const budget = file.runs.find((r) => !r.error)?.params.sendBudget;
  const sendBudget = budget ? `${budget.bytes} B / ${budget.ms} ms` : "none (before the cooperative send loop)";
  return `${name}: ${file.label ?? "-"}, commit ${commit}${dirty ? "+dirty" : ""}, options ${JSON.stringify(file.options ?? {})}, send budget ${sendBudget}`;
}

function main(): void {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) throw new Error("usage: compare <baseline.json> <candidate.json>");
  const baseFile = expect(parseJson(readFileSync(a, "utf8")), isResultFile, "result file");
  const candFile = expect(parseJson(readFileSync(b, "utf8")), isResultFile, "result file");
  const base = rows(baseFile);
  const cand = rows(candFile);
  const lines = [
    describe("baseline", baseFile),
    "",
    describe("candidate", candFile),
    "",
    `| run | ${METRICS.map((m) => m.name).join(" | ")} |`,
    `|---|${METRICS.map(() => "---:").join("|")}|`,
  ];
  for (const key of new Set([...base.keys(), ...cand.keys()])) {
    const x = base.get(key);
    const y = cand.get(key);
    const cells = METRICS.map((m) => {
      const bv = x?.metrics[m.name];
      const cv = y?.metrics[m.name];
      if (bv === undefined && cv === undefined) return "-";
      if (bv === undefined || cv === undefined) return `${bv ?? "-"} → ${cv ?? "-"}`;
      const delta = bv === 0 ? 0 : ((cv - bv) / bv) * 100;
      const better = (m.lowerIsBetter ? delta < 0 : delta > 0) ? "✓" : delta === 0 ? "" : "✗";
      return `${bv} → ${cv} (${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%${better})`;
    });
    lines.push(`| ${key} | ${cells.join(" | ")} |`);
  }
  lines.push("", "| run | counter | baseline | candidate | change |", "|---|---|---:|---:|---:|");
  for (const key of new Set([...base.keys(), ...cand.keys()])) {
    const x = base.get(key)?.stats ?? {};
    const y = cand.get(key)?.stats ?? {};
    for (const path of [...new Set([...Object.keys(x), ...Object.keys(y)])].toSorted()) {
      const bv = x[path];
      const cv = y[path];
      if (!bv && !cv) continue;
      const change = bv && cv !== undefined ? `${(((cv - bv) / bv) * 100).toFixed(1)}%` : "";
      lines.push(`| ${key} | ${path} | ${bv ?? "-"} | ${cv ?? "-"} | ${change} |`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
