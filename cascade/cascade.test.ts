import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = join(import.meta.dirname, "cascade.ts");
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "cascade-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  function git(...args: string[]) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git("init", "-q", "-b", "base");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "file"), "initial");
  git("add", ".");
  git("commit", "-qm", "initial");
  const initial = git("rev-parse", "HEAD");
  git("branch", "child");
  git("branch", "grandchild");
  writeFileSync(join(repo, "file"), "updated");
  git("commit", "-qam", "update");
  const topology = join(dir, "topology.json");
  writeFileSync(
    topology,
    JSON.stringify({
      branches: [
        { name: "base", upstreams: [], enabled: true },
        { name: "child", upstreams: ["base"], enabled: true },
        { name: "grandchild", upstreams: ["child"], enabled: true },
      ],
    }),
  );
  function cascade(extra: string[] = [], env = process.env) {
    const result = spawnSync(process.execPath, [script, "--repo", repo, "--topology", topology, ...extra], {
      encoding: "utf8",
      env: { ...env, TMPDIR: dir, TMP: dir, TEMP: dir },
    });
    const logs = join(repo, ".git/cascade");
    const latest = readdirSync(logs)
      .filter((x) => x !== "verified.json")
      .sort()
      .at(-1)!;
    const report = JSON.parse(readFileSync(join(logs, latest, "report.json"), "utf8"));
    return { ...result, results: report.results };
  }
  return { dir, repo, git, initial, cascade };
}

test("temporary checkouts use LF defaults, honor explicit eol attributes, and compose Git settings", (t) => {
  const f = fixture(t);
  f.git("config", "core.autocrlf", "true");
  f.git("config", "core.eol", "crlf");
  writeFileSync(join(f.repo, ".gitattributes"), "normalized text\nwindows text eol=crlf\n");
  for (const name of ["plain", "normalized", "windows"]) {
    writeFileSync(join(f.repo, name), "line\r\n");
  }
  f.git("add", ".");
  f.git("commit", "-qm", "add text fixtures");

  const hooks = join(f.dir, "hooks");
  mkdirSync(hooks);
  const config = join(f.dir, "effective-config");
  writeFileSync(
    join(hooks, "post-checkout"),
    '#!/bin/sh\nfor key in core.autocrlf core.eol core.longpaths rerere.enabled rerere.autoupdate; do git config --get "$key"; done > "$TEST_CONFIG"\n',
    { mode: 0o755 },
  );
  const result = f.cascade(["--skip-checks", "--keep-worktree"], {
    ...process.env,
    TEST_CONFIG: config,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: hooks,
    GIT_CONFIG_KEY_1: "core.autocrlf",
    GIT_CONFIG_VALUE_1: "true",
    GIT_CONFIG_KEY_2: "core.longpaths",
    GIT_CONFIG_VALUE_2: "false",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(config, "utf8").trim().split(/\r?\n/), ["false", "lf", "true", "true", "false"]);
  const worktree = /^worktree kept: (.+)$/m.exec(result.stdout)?.[1];
  assert.ok(worktree);
  assert.equal(readFileSync(join(worktree, "plain"), "utf8"), "line\n");
  assert.equal(readFileSync(join(worktree, "normalized"), "utf8"), "line\n");
  assert.equal(readFileSync(join(worktree, "windows"), "utf8"), "line\r\n");
  assert.equal(f.git("config", "--local", "core.autocrlf"), "true");
});

test("a failed worktree removal warns and preserves the branch summary, report, and exit status", (t) => {
  const f = fixture(t);
  const hooks = join(f.dir, "hooks");
  mkdirSync(hooks);
  f.git("config", "core.hooksPath", hooks);
  // A locked worktree makes a single --force removal fail on every platform.
  writeFileSync(
    join(hooks, "post-checkout"),
    '#!/bin/sh\nif ! test -f "$(git rev-parse --git-path locked)"; then git worktree lock "$(pwd)"; fi\n',
    { mode: 0o755 },
  );
  const result = f.cascade(["--skip-checks"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Warning: could not remove temporary worktree .*cascade-/);
  assert.match(result.stdout, /^updated\s+grandchild\s/m);
  assert.match(result.stdout, /^report: .*report\.json$/m);
  assert.deepEqual(result.results.map((r: { status: string }) => r.status), ["unchanged", "updated", "updated"]);
});

test("publishes a chain, preserves ancestry, and is idempotent", (t) => {
  const f = fixture(t);
  const first = f.cascade(["--skip-checks"]);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(
    first.results.map((r: { status: string }) => r.status),
    ["unchanged", "updated", "updated"],
  );
  f.git("merge-base", "--is-ancestor", "base", "child");
  f.git("merge-base", "--is-ancestor", "child", "grandchild");
  const tip = f.git("rev-parse", "grandchild");
  assert.equal(f.cascade(["--skip-checks"]).status, 0);
  assert.equal(f.git("rev-parse", "grandchild"), tip);
});

test("refuses checked-out publication and blocks its descendants", (t) => {
  const f = fixture(t);
  f.git("switch", "-q", "child");
  const result = f.cascade(["--skip-checks"]);
  assert.equal(result.status, 1);
  assert.equal(result.results[1].status, "publish-failed");
  assert.equal(result.results[2].status, "blocked");
  assert.equal(f.git("rev-parse", "child"), f.initial);
  assert.equal(f.git("rev-parse", "grandchild"), f.initial);
  assert.equal(readFileSync(join(f.repo, "file"), "utf8"), "initial");
});

test("dry run leaves branch tips intact", (t) => {
  const f = fixture(t);
  assert.equal(f.cascade(["--skip-checks", "--dry-run"]).status, 0);
  assert.equal(f.git("rev-parse", "child"), f.initial);
  assert.equal(f.git("rev-parse", "grandchild"), f.initial);
});

for (const moved of ["base", "child"]) {
  test(`a concurrent ${moved} commit blocks publication of descendants`, (t) => {
    const f = fixture(t);
    // A fake checker changes a ref once during checks, as another terminal could do.
    const bin = join(f.dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "pnpm"),
      `#!/bin/sh\nif [ ! -f '${f.dir}/moved' ]; then\n touch '${f.dir}/moved'\n tree=$(git -C '${f.repo}' rev-parse '${moved}^{tree}')\n parent=$(git -C '${f.repo}' rev-parse '${moved}')\n commit=$(git -C '${f.repo}' commit-tree "$tree" -p "$parent" -m concurrent)\n git -C '${f.repo}' update-ref refs/heads/${moved} "$commit"\nfi\n`,
      { mode: 0o755 },
    );
    const result = f.cascade([], { ...process.env, PATH: `${bin}:${process.env.PATH}` });
    assert.equal(result.status, 1);
    assert.equal(result.results[moved === "base" ? 0 : 1].status, "publish-failed");
    assert.equal(result.results[2].status, "blocked");
    assert.equal(f.git("rev-parse", "grandchild"), f.initial);
  });
}

test("switching the original worktree during checks never updates the newly checked-out branch", (t) => {
  const f = fixture(t);
  f.git("branch", "unrelated", f.initial);
  f.git("switch", "-q", "child");
  const bin = join(f.dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "pnpm"),
    `#!/bin/sh\nif [ ! -f '${f.dir}/switched' ]; then\n touch '${f.dir}/switched'\n git -C '${f.repo}' switch -q unrelated\nfi\n`,
    { mode: 0o755 },
  );
  const result = f.cascade([], { ...process.env, PATH: `${bin}:${process.env.PATH}` });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git("branch", "--show-current"), "unrelated");
  assert.equal(f.git("rev-parse", "unrelated"), f.initial);
  assert.equal(readFileSync(join(f.repo, "file"), "utf8"), "initial");
  f.git("merge-base", "--is-ancestor", "base", "child");
});

for (const moved of ["base", "child"]) {
  test(`moving ${moved} at child publication blocks descendants`, (t) => {
    const f = fixture(t);
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    const bin = join(f.dir, "bin");
    mkdirSync(bin);
    // Interleave another writer immediately before Git acquires the reference lock.
    writeFileSync(
      join(bin, "git"),
      `#!${process.execPath}
  const {spawnSync}=require('node:child_process');
  const fs=require('node:fs');
  const real=${JSON.stringify(realGit)}, repo=${JSON.stringify(f.repo)}, marker=${JSON.stringify(join(f.dir, "raced"))};
  const args=process.argv.slice(2);
  const input=args.includes('--stdin')?fs.readFileSync(0,'utf8'):undefined;
  if(input?.includes('update refs/heads/child ') && !fs.existsSync(marker)) {
   fs.writeFileSync(marker,'');
   const git=(a)=>spawnSync(real,['-C',repo,...a],{encoding:'utf8'}).stdout.trim();
   const commit=git(['commit-tree',git(['rev-parse','${moved}^{tree}']),'-p',git(['rev-parse','${moved}']),'-m','concurrent']);
   git(['update-ref','refs/heads/${moved}',commit]);
  }
  const result=spawnSync(real,args,{input,stdio:[input===undefined?'inherit':'pipe','inherit','inherit']});process.exit(result.status ?? 1);
  `,
      { mode: 0o755 },
    );
    const result = f.cascade(["--skip-checks"], { ...process.env, PATH: `${bin}:${process.env.PATH}` });
    assert.equal(result.status, 1);
    assert.equal(result.results[1].status, "publish-failed");
    assert.match(result.results[1].detail, /compare-and-swap/);
    assert.equal(result.results[2].status, "blocked");
    assert.equal(f.git("rev-parse", "grandchild"), f.initial);
  });
}

test("a failed forced check invalidates the cached success until a normal run passes", (t) => {
  const f = fixture(t);
  const bin = join(f.dir, "bin");
  mkdirSync(bin);
  const checker = join(bin, "pnpm");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  writeFileSync(checker, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal(f.cascade([], env).status, 0);
  writeFileSync(checker, "#!/bin/sh\nexit 1\n");
  assert.equal(f.cascade(["--force-checks"], env).results[0].status, "check-failed");
  assert.equal(f.cascade([], env).results[0].status, "check-failed");
  writeFileSync(checker, "#!/bin/sh\nexit 0\n");
  assert.equal(f.cascade([], env).results[0].status, "verified");
  assert.equal(f.cascade([], env).results[0].status, "unchanged");
});

test("a lockfile conflict leaves both tips intact and blocks downstream publication", (t) => {
  const f = fixture(t);
  for (const [branch, versions] of [["base", "ms: 2.1.3\npicocolors: 1.1.1"], ["child", "ms: 2.1.2\npicocolors: 1.0.0"]]) {
    f.git("switch", "-q", branch);
    writeFileSync(join(f.repo, "pnpm-lock.yaml"), versions + "\n");
    f.git("add", "pnpm-lock.yaml");
    f.git("commit", "-qm", "resolve versions");
  }
  const child = f.git("rev-parse", "child");
  f.git("switch", "-q", "base");
  const result = f.cascade(["--skip-checks"]);
  assert.equal(result.status, 1);
  assert.equal(result.results[1].status, "conflict");
  assert.match(result.results[1].detail, /pnpm-lock.yaml/);
  assert.equal(result.results[2].status, "blocked");
  assert.equal(f.git("rev-parse", "child"), child);
  assert.match(f.git("show", "base:pnpm-lock.yaml"), /picocolors: 1.1.1/);

  // An older run may have recorded a whole-file resolution. A replay must still stop.
  f.git("config", "rerere.enabled", "true");
  f.git("switch", "-q", "--detach", child);
  assert.equal(spawnSync("git", ["merge", "--no-commit", "base"], { cwd: f.repo }).status, 1);
  f.git("checkout", "--ours", "--", "pnpm-lock.yaml");
  f.git("add", "pnpm-lock.yaml");
  f.git("commit", "-qm", "record old resolution");
  f.git("switch", "-q", "base");
  const replay = f.cascade(["--skip-checks"]);
  assert.equal(replay.results[1].status, "conflict");
  assert.match(replay.results[1].detail, /pnpm-lock.yaml/);
  assert.equal(f.git("rev-parse", "child"), child);
});
