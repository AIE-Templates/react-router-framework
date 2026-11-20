import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { build } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PROFILE_ENTRIES } from "./build-profile.ts";
import {
  checkBundleModules,
  recordBundleModules,
  moduleName,
  modulesRecordName,
  readBundleModules,
  realModules,
} from "./bundle-modules.ts";

const [debugEnv, diagnostics, devHost] = PROFILE_ENTRIES;

// Module lists shaped like the ones the builds record.
const shared = ["../../packages/shared/src/index.ts", "electron", "node:path", "src/port-options.ts"];
const testMain = [
  ...shared,
  "src/debug-env.ts",
  "src/debug-env.names.ts",
  "src/diagnostics/bench/bench.ts",
  "src/diagnostics/entry.ts",
  "src/diagnostics/smoke/smoke.ts",
  "src/main.ts",
  "src/main/dev-host.empty.ts",
  "src/main/run-modes.ts",
];
const testUtility = [
  ...shared,
  "src/debug-env.ts",
  "src/debug-env.names.ts",
  "src/diagnostics/bench/routes.ts",
  "src/diagnostics/e2e/routes.ts",
  "src/diagnostics/entry.ts",
  "src/diagnostics/smoke/routes.ts",
  "src/utility.ts",
];
const releaseMain = [
  ...shared,
  "src/debug-env.empty.ts",
  "src/diagnostics/entry.empty.ts",
  "src/main.ts",
  "src/main/dev-host.empty.ts",
];
const releaseUtility = [...shared, "src/debug-env.empty.ts", "src/diagnostics/entry.empty.ts", "src/utility.ts"];
const preload = ["../../packages/shared/src/index.ts", "electron", "src/preload.ts"];
const devMain = [
  ...shared,
  "src/debug-env.ts",
  "src/debug-env.names.ts",
  "src/diagnostics/entry.ts",
  "src/diagnostics/smoke/smoke.ts",
  "src/main.ts",
  "src/main/dev-host.ts",
  "src/main/dev-proxy.ts",
];

function checkListedModules(
  profile: Parameters<typeof checkBundleModules>[0],
  bundle: Parameters<typeof checkBundleModules>[1],
  modules: readonly string[],
) {
  return checkBundleModules(profile, bundle, modules, modules);
}

describe("realModules", () => {
  it("finds an entry's module and what it owns, never its empty implementation", () => {
    expect(realModules(diagnostics, testMain)).toEqual([
      "src/diagnostics/bench/bench.ts",
      "src/diagnostics/entry.ts",
      "src/diagnostics/smoke/smoke.ts",
    ]);
    expect(realModules(diagnostics, releaseMain)).toEqual([]);
    expect(realModules(debugEnv, testUtility)).toEqual(["src/debug-env.ts", "src/debug-env.names.ts"]);
    expect(realModules(debugEnv, releaseUtility)).toEqual([]);
    expect(realModules(devHost, devMain)).toEqual(["src/main/dev-host.ts", "src/main/dev-proxy.ts"]);
    expect(realModules(devHost, testMain)).toEqual([]);
  });

  it("matches whole paths: a directory by its prefix, a file exactly", () => {
    expect(
      realModules(diagnostics, ["src/diagnostics.ts", "src/diagnostics-extra/x.ts", "lib/src/diagnostics/x.ts"]),
    ).toEqual([]);
    expect(
      realModules(devHost, ["src/main/dev-proxy.test.ts", "src/main/dev-proxy.ts.map", "src/dev-proxy.ts"]),
    ).toEqual([]);
    expect(realModules(debugEnv, ["src/debug-env.contract.ts", "src/main/debug-env.ts"])).toEqual([]);
  });
});

describe("checkBundleModules", () => {
  it("accepts what each profile is meant to bundle", () => {
    for (const [profile, bundle, modules] of [
      ["release", "main.cjs", releaseMain],
      ["release", "utility.mjs", releaseUtility],
      ["release", "preload.cjs", preload],
      ["test", "main.cjs", testMain],
      ["test", "utility.mjs", testUtility],
      ["test", "preload.cjs", preload],
      ["dev", "main.cjs", devMain],
    ] as const) {
      expect({ profile, bundle, problems: checkListedModules(profile, bundle, modules).problems }).toEqual({
        profile,
        bundle,
        problems: [],
      });
    }
  });

  it("reports what it established", () => {
    expect(checkListedModules("release", "main.cjs", releaseMain).findings).toEqual([
      "no src/debug-env.ts, src/debug-env.names.ts; src/debug-env.empty.ts instead",
      "no src/diagnostics/entry.ts, src/diagnostics/; src/diagnostics/entry.empty.ts instead",
      "no src/main/dev-host.ts, src/main/dev-proxy.ts; src/main/dev-host.empty.ts instead",
    ]);
    expect(checkListedModules("test", "utility.mjs", testUtility).findings).toEqual([
      "found src/debug-env.ts, src/debug-env.names.ts",
      "found src/diagnostics/bench/routes.ts, src/diagnostics/e2e/routes.ts, src/diagnostics/entry.ts, src/diagnostics/smoke/routes.ts",
      "no src/main/dev-host.ts, src/main/dev-proxy.ts",
    ]);
  });

  it.each([
    ["src/diagnostics/entry.ts", "the entry itself"],
    ["src/diagnostics/smoke/smoke.ts", "a runner reached around the entry"],
    ["src/diagnostics/e2e/routes.ts", "a route module"],
    ["src/diagnostics/new-kind/tool.ts", "anything new under the directory"],
    ["src/debug-env.ts", "the module that reads the debug variables"],
    ["src/debug-env.names.ts", "the names of the debug variables"],
    ["src/main/dev-proxy.ts", "the development proxy"],
    ["src/main/dev-host.ts", "the development host"],
  ])("fails a release bundle that contains %s (%s)", (module) => {
    for (const [bundle, modules] of [
      ["main.cjs", releaseMain],
      ["utility.mjs", releaseUtility],
      ["preload.cjs", preload],
    ] as const) {
      const { problems } = checkListedModules("release", bundle, [...modules, module]);
      expect(problems).toEqual([
        `.vite/release/${bundle} contains ${module}, which the release profile must not bundle`,
      ]);
    }
  });

  it("fails a test bundle that contains development code", () => {
    expect(checkListedModules("test", "main.cjs", [...testMain, "src/main/dev-proxy.ts"]).problems).toEqual([
      ".vite/test/main.cjs contains src/main/dev-proxy.ts, which the test profile must not bundle",
    ]);
  });

  it("fails a release bundle whose entry was not replaced by the empty implementation", () => {
    expect(
      checkListedModules(
        "release",
        "main.cjs",
        releaseMain.filter((id) => id !== "src/diagnostics/entry.empty.ts"),
      ).problems,
    ).toEqual([".vite/release/main.cjs does not contain src/diagnostics/entry.empty.ts"]);
  });

  it("fails the positive control when the test bundles do not show what the check looks for", () => {
    // The release bundles' lists, presented as test: nothing to find means the check proves nothing.
    expect(checkListedModules("test", "main.cjs", releaseMain).problems).toEqual([
      ".vite/test/main.cjs does not contain src/debug-env.ts: the check cannot see what it looks for",
      ".vite/test/main.cjs contains nothing of src/debug-env.names.ts: the check cannot see what it looks for",
      ".vite/test/main.cjs contains src/debug-env.empty.ts, which the test profile must not bundle",
      ".vite/test/main.cjs does not contain src/diagnostics/entry.ts: the check cannot see what it looks for",
      ".vite/test/main.cjs contains nothing of src/diagnostics/: the check cannot see what it looks for",
      ".vite/test/main.cjs contains src/diagnostics/entry.empty.ts, which the test profile must not bundle",
    ]);
    // The entry alone, with nothing of the directory behind it, is not enough either.
    expect(
      checkListedModules(
        "test",
        "utility.mjs",
        testUtility.filter((id) => !id.startsWith("src/diagnostics/") || id === "src/diagnostics/entry.ts"),
      ).problems,
    ).toEqual([".vite/test/utility.mjs contains nothing of src/diagnostics/: the check cannot see what it looks for"]);
    expect(checkListedModules("dev", "main.cjs", testMain).problems).toEqual([
      ".vite/dev/main.cjs does not contain src/main/dev-host.ts: the check cannot see what it looks for",
      ".vite/dev/main.cjs contains nothing of src/main/dev-proxy.ts: the check cannot see what it looks for",
      ".vite/dev/main.cjs contains src/main/dev-host.empty.ts, which the dev profile must not bundle",
    ]);
  });
});

it("keeps a tree-shaken import in the release ban but excludes it from the test positive control", async () => {
  const directory = mkdtempSync(join(tmpdir(), "desktop tree shaking "));
  try {
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src", "debug-env.ts"), "export const unused = 42;");
    writeFileSync(join(directory, "src", "main.js"), 'import "./debug-env.ts"; console.log("live");');
    for (const profile of ["release", "test"] as const) {
      await build({
        root: directory,
        configFile: false,
        logLevel: "silent",
        plugins: [recordBundleModules(profile, directory)],
        build: {
          outDir: `.vite/${profile}`,
          lib: { entry: join(directory, "src/main.js"), formats: ["cjs"], fileName: () => "main.cjs" },
        },
      });
      const { modules, renderedModules } = readBundleModules(directory, profile, "main.cjs");
      expect(modules).toContain(debugEnv.module);
      expect(renderedModules).toContain("src/main.js");
      expect(renderedModules).not.toContain(debugEnv.module);
      const check = checkBundleModules(profile, "main.cjs", modules, renderedModules, [debugEnv]);
      expect(check.problems).toContainEqual(
        expect.stringContaining(
          profile === "release" ? "contains src/debug-env.ts" : "does not contain src/debug-env.ts",
        ),
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("moduleName", () => {
  const desktopDir = resolve("/repo/apps/desktop");
  it("names files from apps/desktop with forward slashes and without queries, and leaves other ids alone", () => {
    expect(moduleName(join(desktopDir, "src", "main", "window.ts"), desktopDir)).toBe("src/main/window.ts");
    expect(moduleName(join(desktopDir, "src", "main.ts") + "?v=1", desktopDir)).toBe("src/main.ts");
    expect(moduleName(resolve("/repo/packages/shared/src/index.ts"), desktopDir)).toBe(
      "../../packages/shared/src/index.ts",
    );
    expect(moduleName("electron", desktopDir)).toBe("electron");
    expect(moduleName("node:fs", desktopDir)).toBe("node:fs");
    expect(moduleName("\0rolldown/runtime.js", desktopDir)).toBe("\0rolldown/runtime.js");
  });
});

/** A record for a bundle file whose content is "bundle". */
function record(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    profile: "release",
    bundle: "main.cjs",
    sha256: createHash("sha256").update("bundle").digest("hex"),
    modules: ["src/main.ts"],
    renderedModules: ["src/main.ts"],
    ...overrides,
  });
}

describe("readBundleModules", () => {
  let directory: string;
  const bundleFile = () => join(directory, ".vite", "release", "main.cjs");
  const recordFile = () => join(directory, ".vite", "release", modulesRecordName("main.cjs"));

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "desktop modules "));
    mkdirSync(join(directory, ".vite", "release"), { recursive: true });
    writeFileSync(bundleFile(), "bundle");
    writeFileSync(recordFile(), record());
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("reads the record written for the bundle on disk", () => {
    expect(readBundleModules(directory, "release", "main.cjs")).toMatchObject({
      profile: "release",
      bundle: "main.cjs",
      modules: ["src/main.ts"],
    });
  });

  it("says what to run when the bundle or its record is missing", () => {
    expect(() => readBundleModules(directory, "test", "main.cjs")).toThrow(
      ".vite/test/main.cjs is missing: run `pnpm build:desktop` first",
    );
    rmSync(recordFile());
    expect(() => readBundleModules(directory, "release", "main.cjs")).toThrow(
      ".vite/release/main.cjs.modules.json is missing: run `pnpm release:desktop` first",
    );
    rmSync(bundleFile());
    expect(() => readBundleModules(directory, "release", "main.cjs")).toThrow(".vite/release/main.cjs is missing");
  });

  it("rejects a record that is stale, foreign or malformed", () => {
    writeFileSync(bundleFile(), "rebuilt without its record");
    expect(() => readBundleModules(directory, "release", "main.cjs")).toThrow(
      ".vite/release/main.cjs.modules.json is stale",
    );
    writeFileSync(bundleFile(), "bundle");
    writeFileSync(recordFile(), record({ profile: "test" }));
    expect(() => readBundleModules(directory, "release", "main.cjs")).toThrow("describes main.cjs of the test profile");
    writeFileSync(recordFile(), record({ bundle: "utility.mjs" }));
    expect(() => readBundleModules(directory, "release", "main.cjs")).toThrow("describes utility.mjs");
    writeFileSync(recordFile(), record({ modules: "src/main.ts" }));
    expect(() => readBundleModules(directory, "release", "main.cjs")).toThrow("is not a bundle module record");
    writeFileSync(recordFile(), "[]");
    expect(() => readBundleModules(directory, "release", "main.cjs")).toThrow("is not a bundle module record");
  });
});
