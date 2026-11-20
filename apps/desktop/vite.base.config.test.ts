import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve, sep } from "node:path";

import { build } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BUILD_PROFILES, type BuildProfile, PROFILE_ENTRIES } from "./scripts/build-profile.ts";
import { moduleName, modulesRecordName } from "./scripts/bundle-modules.ts";
import { entryConfig } from "./vite.base.config";

afterEach(() => vi.unstubAllEnvs());

const options = { entry: "src/main.ts", fileName: "main.cjs", format: "cjs" } as const;

it.each([
  { profile: "dev", watch: true, mode: "development", devServerUrl: "http://localhost:5174" },
  { profile: "test", watch: false, mode: "production", devServerUrl: null },
  { profile: "release", watch: false, mode: "production", devServerUrl: null },
])(
  "builds the $profile profile (watch $watch) into its own directory with the intended runtime",
  async ({ profile, watch, mode, devServerUrl }) => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DESKTOP_BUILD_PROFILE", profile);
    // Only the dev profile takes it; in the others it must change nothing.
    vi.stubEnv("DESKTOP_DEV_SERVER_URL", "http://localhost:5174");
    const directory = mkdtempSync(join(tmpdir(), "desktop vite "));
    const entry = join(directory, "entry.js");
    const fileName = "output.cjs";
    try {
      writeFileSync(
        entry,
        `console.log(JSON.stringify({
  profile: DESKTOP_BUILD_PROFILE,
  mode: process.env.NODE_ENV,
  devServerUrl: DESKTOP_DEV_SERVER_URL ?? null,
  logLevel: process.env.LOG_LEVEL,
  bootProfile: process.env.DESKTOP_BOOT_PROFILE,
}));`,
      );
      const config = entryConfig({ entry, fileName, format: "cjs" });
      expect(config.build?.outDir).toBe(`.vite/${profile}`);
      expect(config.build?.watch).toEqual(watch ? {} : null);
      expect(config.build?.minify).toBe(profile !== "dev");
      await build({
        ...config,
        configFile: false,
        logLevel: "silent",
        // Compile one watch iteration without leaving a filesystem watcher running in the suite.
        build: { ...config.build, outDir: join(directory, "dist"), watch: null },
      });
      const output = join(directory, "dist", fileName);
      const result = spawnSync(process.execPath, [output], {
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "development", LOG_LEVEL: "debug", DESKTOP_BOOT_PROFILE: "1" },
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ profile, mode, devServerUrl, logLevel: "debug", bootProfile: "1" });
      // The module record written beside the bundle is for exactly that bundle.
      const record: unknown = JSON.parse(readFileSync(join(directory, "dist", modulesRecordName(fileName)), "utf8"));
      expect(record).toEqual({
        profile,
        bundle: fileName,
        sha256: createHash("sha256").update(readFileSync(output)).digest("hex"),
        modules: [moduleName(realpathSync(entry), import.meta.dirname)],
        renderedModules: [moduleName(realpathSync(entry), import.meta.dirname)],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

const desktop = (path: string) => resolve(import.meta.dirname, path);
/** What an import of `specifier` resolves to under a profile's aliases; undefined when no alias applies. */
function aliased(profile: BuildProfile, specifier: string): string | undefined {
  vi.stubEnv("DESKTOP_DEV_SERVER_URL", profile === "dev" ? "http://localhost:5174" : undefined);
  const { alias } = entryConfig(options, profile).resolve ?? {};
  if (!Array.isArray(alias)) throw new Error("resolve.alias is not a list");
  const match = alias.find(({ find }) => (typeof find === "string" ? find === specifier : find.test(specifier)));
  return match?.replacement;
}

describe("the source modules a profile does not bundle", () => {
  it("release replaces the debug environment, the diagnostics and the development host with their empty implementations", () => {
    expect(aliased("release", "~/debug-env.ts")).toBe(desktop("src/debug-env.empty.ts"));
    expect(aliased("release", "~/diagnostics/entry.ts")).toBe(desktop("src/diagnostics/entry.empty.ts"));
    expect(aliased("release", "~/main/dev-host.ts")).toBe(desktop("src/main/dev-host.empty.ts"));
    expect(entryConfig(options, "release").resolve?.alias).toHaveLength(3);
  });

  it("test keeps the debug environment and the diagnostics and replaces only the development host", () => {
    expect(aliased("test", "~/debug-env.ts")).toBeUndefined();
    expect(aliased("test", "~/diagnostics/entry.ts")).toBeUndefined();
    expect(aliased("test", "~/main/dev-host.ts")).toBe(desktop("src/main/dev-host.empty.ts"));
    expect(entryConfig(options, "test").resolve?.alias).toHaveLength(1);
  });

  it("dev replaces nothing", () => {
    for (const { specifier } of PROFILE_ENTRIES) expect(aliased("dev", specifier)).toBeUndefined();
    vi.stubEnv("DESKTOP_DEV_SERVER_URL", "http://localhost:5174");
    expect(entryConfig(options, "dev").resolve?.alias).toEqual([]);
  });

  it.each(BUILD_PROFILES)("%s replaces whole specifiers only, and only the ones source uses", (profile) => {
    for (const specifier of [
      "~/debug-env.contract.ts",
      "~/debug-env.empty.ts",
      "~/diagnostics/entry.contract.ts",
      "~/diagnostics/entry.tsx",
      "x~/diagnostics/entry.ts",
      "~/main/dev-host-ts",
      "~/main/dev-proxy.ts",
      "~/main/log.ts",
    ]) {
      expect(aliased(profile, specifier)).toBeUndefined();
    }
  });

  it("every entry exists, as do its empty implementation and what it owns, under the specifier source imports", () => {
    const paths = PROFILE_ENTRIES.flatMap((entry) => [entry.module, entry.empty, ...entry.owns]);
    expect(paths.filter((path) => !existsSync(desktop(path)))).toEqual([]);
    for (const entry of PROFILE_ENTRIES) {
      // `~/` is `src/` (tsconfig.json), so the alias and the real module answer to the same specifier.
      expect(entry.specifier).toBe(entry.module.replace(/^src\//, "~/"));
      expect(dirname(entry.empty)).toBe(dirname(entry.module));
    }
  });

  it("every importer uses exactly the specifier the build replaces", () => {
    const files = readdirSync(desktop("src"), { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => join("src", file).split(sep).join("/"));
    expect(files.length).toBeGreaterThan(30);
    // Value imports only: a type import is erased and reaches no bundle.
    const valueImports = files.flatMap((file) =>
      Array.from(
        readFileSync(desktop(file), "utf8").matchAll(/^(?:import|export) (?!type\b)[^;]*?from "([^"]+)";/gms),
        (match) => ({ file, specifier: match[1], module: importedSource(file, match[1]) }),
      ),
    );
    expect(valueImports.length).toBeGreaterThan(50);
    for (const entry of PROFILE_ENTRIES) {
      const imports = valueImports.filter(({ module }) => module === entry.module);
      // Any other spelling of the same module (relative, or without its extension) would slip past the alias.
      expect(imports.filter(({ specifier }) => specifier !== entry.specifier)).toEqual([]);
      expect(imports.map(({ file }) => file).toSorted()).toEqual(entry.bundles.map(sourceOf).toSorted());
    }
  });
});

/** The source file under apps/desktop an import in `file` names, for `~/` and relative specifiers. */
function importedSource(file: string, specifier: string): string | undefined {
  const path = specifier.startsWith("~/")
    ? `src/${specifier.slice(2)}`
    : specifier.startsWith(".")
      ? posix.join(posix.dirname(file), specifier)
      : undefined;
  return path === undefined || path.endsWith(".ts") ? path : `${path}.ts`;
}

/** The source entry of a bundle. */
function sourceOf(bundle: string): string {
  return `src/${bundle.split(".")[0]}.ts`;
}

it("builds the release profile when none is named", () => {
  vi.stubEnv("DESKTOP_BUILD_PROFILE", undefined);
  const config = entryConfig(options);
  expect(config.build?.outDir).toBe(".vite/release");
  expect(config.define).toMatchObject({ DESKTOP_BUILD_PROFILE: '"release"' });
});

it("takes an explicit profile over the environment", () => {
  vi.stubEnv("DESKTOP_BUILD_PROFILE", "test");
  expect(entryConfig(options, "release").build?.outDir).toBe(".vite/release");
});

it("decides watch mode and the development server address by the profile alone", () => {
  // What used to select development is ignored outside the dev profile.
  vi.stubEnv("DESKTOP_WATCH", "1");
  vi.stubEnv("DESKTOP_DEV_SERVER_URL", "http://localhost:5174");
  for (const profile of ["test", "release"] as const) {
    const config = entryConfig(options, profile);
    expect(config.build?.watch).toBeNull();
    expect(config.define).toMatchObject({ DESKTOP_DEV_SERVER_URL: "undefined" });
  }
  vi.stubEnv("DESKTOP_WATCH", undefined);
  const dev = entryConfig(options, "dev");
  expect(dev.build?.watch).toEqual({});
  expect(dev.define).toMatchObject({ DESKTOP_DEV_SERVER_URL: '"http://localhost:5174"' });
});

it("rejects an unknown profile and a dev profile without its development server", () => {
  vi.stubEnv("DESKTOP_BUILD_PROFILE", "build");
  expect(() => entryConfig(options)).toThrow('Unknown desktop build profile "build"');
  vi.stubEnv("DESKTOP_BUILD_PROFILE", "dev");
  vi.stubEnv("DESKTOP_DEV_SERVER_URL", undefined);
  expect(() => entryConfig(options)).toThrow("The dev profile is built by scripts/dev.ts only");
  vi.stubEnv("DESKTOP_DEV_SERVER_URL", "");
  expect(() => entryConfig(options)).toThrow("The dev profile is built by scripts/dev.ts only");
});
