#!/usr/bin/env node
/**
 * Propagates template branch changes downstream, following topology.json.
 *
 *   node cascade/cascade.ts [--repo <path>] [--topology <file>] [--dry-run] [--skip-checks] [--force-checks] [--keep-worktree]
 *
 * Every input branch tip is fixed when the run starts. Branches are processed upstreams first in a
 * temporary worktree on detached commits: each upstream the branch does not contain yet is merged
 * as its own merge commit, then the result is verified. Nothing is published until a branch passes
 * its checks, and only then by moving the branch from the tip it had at the start (a branch moved
 * meanwhile is reported, not overwritten). A branch that conflicts or fails blocks its descendants.
 *
 * Conflicts: rerere replays earlier resolutions (its cache lives in the repository's .git and is
 * shared with manual merges). Package manifests get a three-way merge by key. Lockfile conflicts,
 * including whole-file resolutions replayed from older runs, require a manual merge on the branch.
 * Resolve outstanding conflicts and rerun. Finished branches are skipped.
 *
 * Merge commits skip the Git hooks: the hooks lint staged files with the branch's own dependencies,
 * which the checks below cover on the whole tree before anything is published.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { formatPackageJson, mergePackageJson } from "./package-merge.ts";
import { enabledOrder, type Topology } from "./topology.ts";

const CHECKS: string[][] = [
  ["pnpm", "install", "--frozen-lockfile"],
  ["pnpm", "lint"],
  ["pnpm", "fmt:check"],
  ["pnpm", "typecheck"],
  ["pnpm", "exec", "vitest", "run"],
  ["pnpm", "build"],
];

type Status =
  | "unchanged"
  | "verified"
  | "updated"
  | "conflict"
  | "check-failed"
  | "error"
  | "blocked"
  | "publish-failed";

interface NodeResult {
  branch: string;
  status: Status;
  from: string;
  to?: string;
  merged: string[];
  /** Files resolved automatically, and how. */
  resolved: { file: string; by: "rerere" | "package-merge" }[];
  detail?: string;
  log?: string;
}

const { values: options } = parseArgs({
  options: {
    repo: { type: "string", default: resolve(import.meta.dirname, "..") },
    topology: { type: "string", default: join(import.meta.dirname, "topology.json") },
    "dry-run": { type: "boolean", default: false },
    "skip-checks": { type: "boolean", default: false },
    "force-checks": { type: "boolean", default: false },
    "keep-worktree": { type: "boolean", default: false },
  },
});
const repo = resolve(options.repo);

// rerere for this run's merges, whatever the repository's own configuration says.
Object.assign(process.env, {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "rerere.enabled",
  GIT_CONFIG_VALUE_0: "true",
  GIT_CONFIG_KEY_1: "rerere.autoupdate",
  GIT_CONFIG_VALUE_1: "false",
});

function run(args: string[], cwd: string, allowFailure = false, env?: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  const [command, ...rest] = args;
  const result = spawnSync(command, rest, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : undefined,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${args.join(" ")} failed in ${cwd}:\n${result.stdout}${result.stderr}`);
  }
  return result;
}

const git = (cwd: string, ...args: string[]) => run(["git", ...args], cwd).stdout.trim();
const gitOk = (cwd: string, ...args: string[]) => run(["git", ...args], cwd, true).status === 0;
const lines = (text: string) => text.split("\n").filter(Boolean);

/** Branches checked out in a worktree, by branch name: publishing moves those with the worktree. */
function checkedOutBranches(): Map<string, string> {
  const found = new Map<string, string>();
  let path = "";
  for (const line of lines(git(repo, "worktree", "list", "--porcelain"))) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    if (line.startsWith("branch refs/heads/")) found.set(line.slice("branch refs/heads/".length), path);
  }
  return found;
}

/** Stage replayed resolutions only after checking which paths actually conflicted. */
function resolveConflicts(cwd: string, result: NodeResult): string[] {
  const unmerged = lines(git(cwd, "diff", "--name-only", "--diff-filter=U"));
  const pending = new Set(lines(git(cwd, "rerere", "remaining")));
  const remaining: string[] = [];
  for (const file of unmerged) {
    if (/(^|\/)pnpm-lock\.yaml$/.test(file)) {
      remaining.push(file);
      continue;
    }
    if (!pending.has(file)) {
      git(cwd, "add", "--", file);
      result.resolved.push({ file, by: "rerere" });
      continue;
    }
    if (file === "package.json" || file.endsWith("/package.json")) {
      const stage = (n: 2 | 3) => {
        const shown = run(["git", "show", `:${n}:${file}`], cwd, true);
        return shown.status === 0 ? shown.stdout : undefined;
      };
      const ours = stage(2);
      const theirs = stage(3);
      if (ours !== undefined && theirs !== undefined) {
        // Every merge base, not stage 1: with several bases Git's virtual base can hold conflict markers.
        const bases = lines(git(cwd, "merge-base", "--all", "HEAD", "MERGE_HEAD")).map((base) => {
          const shown = run(["git", "show", `${base}:${file}`], cwd, true);
          return shown.status === 0 ? shown.stdout : undefined;
        });
        const merged = mergePackageJson(bases, ours, theirs);
        if (merged.ok) {
          writeFileSync(join(cwd, file), formatPackageJson(merged.value));
          git(cwd, "add", "--", file);
          result.resolved.push({ file, by: "package-merge" });
          continue;
        }
        remaining.push(`${file} (${merged.conflicts.map((c) => `${c.path}: ${c.reason}`).join(", ")})`);
        continue;
      }
    }
    remaining.push(file);
  }
  return remaining;
}

/** Runs CHECKS on the worktree's HEAD; returns the failed result, or undefined when all pass. */
function runChecks(cwd: string, branch: string, logDir: string, result: NodeResult): NodeResult | undefined {
  const log = join(logDir, `${branch.replaceAll("/", "_")}.log`);
  let output = "";
  for (const check of CHECKS) {
    // CI keeps lefthook's install script from rewriting the repository's shared Git hooks to
    // point into this temporary worktree.
    const ran = run(check, cwd, true, { CI: "1" });
    output += `$ ${check.join(" ")}\n${ran.stdout}${ran.stderr}\n`;
    writeFileSync(log, output);
    if (ran.status !== 0) return { ...result, status: "check-failed", detail: check.join(" "), log };
  }
  result.log = log;
  return undefined;
}

function processBranch(
  cwd: string,
  branch: string,
  upstreams: string[],
  tips: Map<string, string>,
  logDir: string,
  verified: Record<string, string>,
): NodeResult {
  const from = tips.get(branch)!;
  const result: NodeResult = { branch, status: "unchanged", from, merged: [], resolved: [] };
  const pending = upstreams.filter((upstream) => !gitOk(cwd, "merge-base", "--is-ancestor", tips.get(upstream)!, from));
  if (pending.length === 0) {
    // Nothing to merge, but commits made outside a run (a manual merge resolving a conflict, a
    // change to a source branch) have not been checked yet: check them before descendants build on
    // them.
    if (options["skip-checks"] || (!options["force-checks"] && verified[branch] === from)) return result;
    // Only a successful recheck can restore this tip, including when the checker fails to start.
    delete verified[branch];
    git(cwd, "switch", "--quiet", "--detach", from);
    git(cwd, "clean", "-ffdxq");
    return runChecks(cwd, branch, logDir, result) ?? { ...result, status: "verified" };
  }

  git(cwd, "switch", "--quiet", "--detach", from);
  // Each branch installs from scratch: node_modules left by another branch can break packages
  // whose install scripts unpack binaries (Electron). The pnpm store keeps this fast.
  git(cwd, "clean", "-ffdxq");
  let manifestsChanged = false;
  for (const upstream of pending) {
    const merge = run(
      [
        "git",
        "merge",
        "--no-ff",
        "--no-commit",
        "--no-verify",
        "-m",
        `Merge branch '${upstream}' into ${branch}`,
        tips.get(upstream)!,
      ],
      cwd,
      true,
    );
    if (merge.status !== 0) {
      const remaining = resolveConflicts(cwd, result);
      if (remaining.length > 0) {
        git(cwd, "merge", "--abort");
        return {
          ...result,
          status: "conflict",
          detail: `merging ${upstream}: ${remaining.join("; ")}. Resolve with \`git switch ${branch} && git merge ${upstream}\`, then run again.`,
        };
      }
    }
    const changed = lines(git(cwd, "diff", "--cached", "--name-only", "HEAD"));
    if (changed.some((file) => /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(file))) {
      manifestsChanged = true;
      // The lockfile follows the merged manifests, keeping existing resolutions; pnpm's compatible version range is
      // declared by devEngines in the root package.json.
      run(["pnpm", "install", "--lockfile-only", "--ignore-scripts", "--prefer-offline"], cwd);
      git(cwd, "add", "--", "pnpm-lock.yaml");
    }
    git(cwd, "commit", "--quiet", "--no-verify", "--no-edit");
    result.merged.push(upstream);
  }

  if (!options["skip-checks"]) {
    const failed = runChecks(cwd, branch, logDir, result);
    if (failed) return failed;
  }
  return {
    ...result,
    status: "updated",
    to: git(cwd, "rev-parse", "HEAD"),
    detail: manifestsChanged ? "lockfile regenerated" : undefined,
  };
}

/** Git locks the parent refs and the destination together, or leaves the destination alone. */
function publish(result: NodeResult, upstreams: string[], tips: Map<string, string>): boolean {
  const commands = upstreams.map((parent) => `verify refs/heads/${parent} ${tips.get(parent)!}`);
  commands.push(`update refs/heads/${result.branch} ${result.to!} ${result.from}`);
  const transaction = spawnSync("git", ["update-ref", "-m", "cascade", "--stdin"], {
    cwd: repo,
    input: commands.join("\n") + "\n",
  });
  return transaction.status === 0;
}

function main() {
  const topology = JSON.parse(readFileSync(options.topology, "utf8")) as Topology;
  const order = enabledOrder(topology);
  const tips = new Map<string, string>();
  for (const node of order) {
    if (!gitOk(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${node.name}`))
      throw new Error(`branch ${node.name} is enabled in the topology but does not exist`);
    tips.set(node.name, git(repo, "rev-parse", `refs/heads/${node.name}`));
  }
  const start = new Map(tips);
  const checkedOut = checkedOutBranches();
  if (!options["dry-run"]) {
    for (const node of order) {
      const path = checkedOut.get(node.name);
      if (path && git(path, "status", "--porcelain"))
        throw new Error(`${node.name} is checked out with changes in ${path}`);
    }
  }

  const runDir = join(
    git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    "cascade",
    new Date().toISOString().replaceAll(":", "-"),
  );
  mkdirSync(runDir, { recursive: true });
  // The last commit of each branch that passed the checks, so commits made outside a run get checked.
  const verifiedFile = join(runDir, "..", "verified.json");
  const verified = (existsSync(verifiedFile) ? JSON.parse(readFileSync(verifiedFile, "utf8")) : {}) as Record<
    string,
    string
  >;
  const worktree = mkdtempSync(join(tmpdir(), "cascade-"));
  git(repo, "worktree", "add", "--quiet", "--detach", worktree, tips.get(order[0].name)!);

  const results: NodeResult[] = [];
  const failed = new Set<string>();
  try {
    for (const node of order) {
      const blockedBy = node.upstreams.filter((upstream) => failed.has(upstream));
      if (blockedBy.length > 0) {
        failed.add(node.name);
        results.push({
          branch: node.name,
          status: "blocked",
          from: tips.get(node.name)!,
          merged: [],
          resolved: [],
          detail: `by ${blockedBy.join(", ")}`,
        });
        continue;
      }
      process.stderr.write(`${node.name} …\n`);
      let result: NodeResult;
      try {
        result = processBranch(worktree, node.name, node.upstreams, tips, runDir, verified);
      } catch (error) {
        // A command that should not fail did (the network, a broken install): stop this branch only.
        if (gitOk(worktree, "rev-parse", "--verify", "--quiet", "MERGE_HEAD")) git(worktree, "merge", "--abort");
        result = {
          branch: node.name,
          status: "error",
          from: tips.get(node.name)!,
          merged: [],
          resolved: [],
          detail: String(error instanceof Error ? error.message : error)
            .split("\n")
            .slice(0, 12)
            .join("\n"),
        };
      }
      if (result.status === "updated") tips.set(node.name, result.to!);
      else if (result.status === "verified") verified[node.name] = result.from;
      else if (result.status !== "unchanged") failed.add(node.name);
      results.push(result);
    }

    if (!options["dry-run"]) {
      // Recheck every source too: an unchanged source may have moved while descendants were tested.
      // Never merge through a remembered worktree path. A user can switch branches there at any time.
      for (const result of results) {
        const node = order.find((node) => node.name === result.branch)!;
        const blockedBy = node.upstreams.filter((upstream) => failed.has(upstream));
        if (blockedBy.length) {
          result.status = "blocked";
          result.detail = `publication blocked by ${blockedBy.join(", ")}`;
          failed.add(result.branch);
          continue;
        }
        if (!["updated", "verified", "unchanged"].includes(result.status)) continue;
        const ref = `refs/heads/${result.branch}`;
        let reason: string | undefined;
        if (git(repo, "rev-parse", ref) !== start.get(result.branch)) {
          reason = "the branch moved during the run; run again";
        } else if (result.status === "updated" && checkedOutBranches().has(result.branch)) {
          reason = "branch is checked out; detach its worktree HEAD, then run again";
        } else if (result.status === "updated" && !publish(result, node.upstreams, tips)) {
          reason = "compare-and-swap publication failed; run again";
        }
        if (reason) {
          result.status = "publish-failed";
          result.detail = reason;
          failed.add(result.branch);
          delete verified[result.branch];
        } else if (result.status === "updated" && !options["skip-checks"]) {
          verified[result.branch] = result.to!;
        }
      }
    }
  } finally {
    if (!options["keep-worktree"]) git(repo, "worktree", "remove", "--force", worktree);
  }

  writeFileSync(join(runDir, "report.json"), `${JSON.stringify({ dryRun: options["dry-run"], results }, null, 2)}\n`);
  writeFileSync(verifiedFile, `${JSON.stringify(verified, null, 2)}\n`);
  for (const result of results) {
    const range = result.to ? `${result.from.slice(0, 8)} → ${result.to.slice(0, 8)}` : result.from.slice(0, 8);
    const merged = result.merged.length ? ` merged ${result.merged.join(", ")}` : "";
    const resolved = result.resolved.length
      ? ` resolved ${result.resolved.map((r) => `${r.file} (${r.by})`).join(", ")}`
      : "";
    console.log(
      `${result.status.padEnd(14)} ${result.branch.padEnd(24)} ${range}${merged}${resolved}${result.detail ? ` — ${result.detail}` : ""}${result.log && result.status !== "updated" ? ` (log: ${result.log})` : ""}`,
    );
  }
  console.log(`${options["dry-run"] ? "dry run, nothing published; " : ""}report: ${join(runDir, "report.json")}`);
  if (options["keep-worktree"]) console.log(`worktree kept: ${worktree}`);
  process.exitCode = failed.size > 0 || results.some((r) => r.status === "publish-failed") ? 1 : 0;
}

main();
