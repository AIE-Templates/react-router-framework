import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { arch, cpus, platform, release, totalmem } from "node:os";

export interface Environment {
  commit: string;
  /** Whether the working tree had uncommitted changes (`git status --porcelain`) when the run started. */
  dirty: boolean;
  node: string;
  v8: string;
  ws: string;
  cpu: string;
  cores: number;
  arch: string;
  platform: string;
  osRelease: string;
  totalMemoryBytes: number;
  recordedAt: string;
}

function git(args: string): string {
  return execSync(`git ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export function environment(): Environment {
  let commit = "unknown";
  let dirty = false;
  try {
    commit = git("rev-parse --short HEAD").trim();
    dirty = git("status --porcelain").trim().length > 0;
  } catch {}
  const require = createRequire(import.meta.url);
  const wsPackage: unknown = require("ws/package.json");
  const ws =
    typeof wsPackage === "object" &&
    wsPackage !== null &&
    "version" in wsPackage &&
    typeof wsPackage.version === "string"
      ? wsPackage.version
      : "unknown";
  return {
    commit,
    dirty,
    node: process.versions.node,
    v8: process.versions.v8,
    ws,
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    arch: arch(),
    platform: platform(),
    osRelease: release(),
    totalMemoryBytes: totalmem(),
    recordedAt: new Date().toISOString(),
  };
}
