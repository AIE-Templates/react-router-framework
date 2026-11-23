#!/usr/bin/env node
/** Read-only ownership, ancestry and reference inventory audit; never checks out a branch. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";

import { enabledOrder, type Topology } from "./topology.ts";
import { ownedFileViolation, retiredWebPath } from "./ownership.ts";

const { values } = parseArgs({
  options: {
    repo: { type: "string", default: resolve(import.meta.dirname, "..") },
    reference: { type: "string" },
  },
});
const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const files = (repo: string, branch: string) =>
  git(repo, "ls-tree", "-r", "--name-only", branch).split("\n");
const errors: string[] = [];
const topology = JSON.parse(
  readFileSync(join(import.meta.dirname, "topology.json"), "utf8"),
) as Topology;
for (const node of enabledOrder(topology)) {
  for (const upstream of node.upstreams) {
    try {
      git(values.repo, "merge-base", "--is-ancestor", upstream, node.name);
    } catch {
      errors.push(`${node.name} does not contain ${upstream}`);
    }
  }
  const inventory = files(values.repo, node.name);
  const electron = node.name.startsWith("platform/electron/");
  const core = electron || node.name.startsWith("app/");
  for (const path of inventory) {
    const violation = ownedFileViolation(node.name, path);
    if (violation) errors.push(`${node.name}: ${violation} ${path}`);
    if (retiredWebPath(path)) errors.push(`${node.name}: retired Web path ${path}`);
  }
  if (core && !electron) {
    for (const path of inventory.filter(
      (p) => /\.(ts|tsx)$/.test(p) && /^(packages\/shared\/src|apps\/web\/src\/app)\//.test(p),
    )) {
      if (
        /DesktopRequest|DESKTOP_CHROME_IPC|DESKTOP_PREFS_IPC|desktopBootstrapFromArguments|shellFromEnv|x-desktop-/.test(
          git(values.repo, "show", `${node.name}:${path}`),
        )
      )
        errors.push(`${node.name}: host protocol leaked into ${path}`);
    }
  }
}
const branch = "platform/electron/core";
const target = files(values.repo, branch);
const reference = values.reference ? files(values.reference, "HEAD") : [];
const missing = reference.filter((p) => !target.includes(p));
for (const path of missing) {
  if (!path.startsWith("docs/archive/") && !path.startsWith("docs/validation/"))
    errors.push(`reference file missing: ${path}`);
}
const changed = reference.filter(
  (p) =>
    target.includes(p) &&
    git(values.repo, "rev-parse", `${branch}:${p}`) !==
      git(values.reference!, "rev-parse", `HEAD:${p}`),
);
console.log(
  JSON.stringify(
    {
      referenceCommit: values.reference ? git(values.reference, "rev-parse", "HEAD") : null,
      targetCommit: git(values.repo, "rev-parse", branch),
      missing,
      added: values.reference ? target.filter((p) => !reference.includes(p)) : [],
      changed,
      errors,
    },
    null,
    2,
  ),
);
process.exitCode = errors.length ? 1 : 0;
