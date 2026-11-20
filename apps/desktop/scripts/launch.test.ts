import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { packagedExecutable } from "../e2e/packaged-path.ts";
import { WEB_SERVER_RECORD, webServerDigest } from "./check-web-build.ts";
import {
  buildProfileMismatch,
  checkLaunchInputs,
  checkUnpackagedBuild,
  electronBinary,
  launchSpec,
  reportedBuildProfile,
  verifyBuildProfile,
  writeDevPackageJson,
} from "./launch.ts";

const startupLine = (profile: string) =>
  JSON.stringify({
    level: "info",
    time: "2026-01-01T00:00:00.000Z",
    process: "main",
    buildProfile: profile,
    msg: "build profile",
  });

describe("startup line", () => {
  it("reads the build profile only from the main process's startup line", () => {
    expect(reportedBuildProfile(startupLine("release"))).toBe("release");
    expect(reportedBuildProfile(JSON.stringify({ process: "utility", buildProfile: "test" }))).toBeUndefined();
    expect(reportedBuildProfile(JSON.stringify({ process: "main", msg: "window chrome policy" }))).toBeUndefined();
    expect(reportedBuildProfile('{"process":"main","buildProfile":')).toBeUndefined();
    expect(reportedBuildProfile("[12345:ERROR:gpu] buildProfile test")).toBeUndefined();
  });
});

describe("build profile verification", () => {
  it("accepts the expected profile from a line split across chunks, without disturbing other readers", async () => {
    const stdout = new PassThrough();
    const seen: Buffer[] = [];
    stdout.on("data", (chunk: Buffer) => seen.push(chunk));
    const verified = verifyBuildProfile(stdout, "test");
    const line = Buffer.from(`Électron noise\n${startupLine("test")}\n`);
    // Split inside the multi-byte É and inside the JSON line.
    stdout.write(line.subarray(0, 1));
    stdout.write(line.subarray(1, 40));
    stdout.write(line.subarray(40));
    await expect(verified).resolves.toBeUndefined();
    expect(stdout.listenerCount("data")).toBe(1);
    expect(stdout.readableFlowing).toBe(true);
    stdout.write("later\n");
    await new Promise((done) => setImmediate(done));
    expect(Buffer.concat(seen).toString()).toBe(`${line.toString()}later\n`);
  });

  it("rejects another profile", async () => {
    const stdout = new PassThrough();
    const verified = verifyBuildProfile(stdout, "test");
    stdout.write(`${startupLine("release")}\n`);
    await expect(verified).rejects.toThrow('The launched app reports build profile "release", expected "test"');
  });

  it("rejects output that ends before the startup line", async () => {
    const stdout = new PassThrough();
    const verified = verifyBuildProfile(stdout, "dev");
    stdout.end("not a log line\n");
    await expect(verified).rejects.toThrow("exited before reporting its build profile (expected dev)");
  });

  it("gives up after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const verified = verifyBuildProfile(new PassThrough(), "test", 1000);
      vi.advanceTimersByTime(1000);
      await expect(verified).rejects.toThrow("did not report its build profile within 1000 ms");
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Where this checkout's Electron and its helpers run from: the macOS bundle, else its directory. */
function electronProcessDir(): string {
  const binary = electronBinary();
  return process.platform === "darwin" ? binary.slice(0, binary.lastIndexOf(".app/") + 4) : dirname(binary);
}

describe("launch spec", () => {
  let directory: string;
  const metadata = { name: "desktop", productName: "My Product", version: "1.2.3" };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "desktop launch spec "));
    writeFileSync(join(directory, "package.json"), JSON.stringify(metadata));
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("starts the unpackaged test bundles as `electron .` in apps/desktop", () => {
    expect(launchSpec("unpackaged", "test", { directory })).toEqual({
      target: "unpackaged",
      profile: "test",
      command: electronBinary(),
      args: ["."],
      cwd: directory,
      env: { NODE_ENV: "production" },
      processDir: electronProcessDir(),
    });
  });

  it("starts the dev bundles on their directory", () => {
    expect(launchSpec("unpackaged", "dev", { directory })).toMatchObject({
      command: electronBinary(),
      args: [join(directory, ".vite", "dev")],
      cwd: directory,
      env: { NODE_ENV: "development" },
    });
  });

  it("starts the packaged test app from out/test, or the executable named", () => {
    const packaged = packagedExecutable(join(directory, "out", "test"), metadata, process.platform, process.arch);
    expect(launchSpec("packaged", "test", { directory })).toMatchObject({
      command: resolve(packaged),
      args: [],
      cwd: dirname(resolve(packaged)),
      env: { NODE_ENV: "production" },
    });
    const other = join(directory, "elsewhere", "Desktop");
    expect(launchSpec("packaged", "test", { directory, executable: other })).toMatchObject({
      command: other,
      processDir: dirname(other),
    });
  });

  it.each([
    ["unpackaged", "release"],
    ["packaged", "release"],
    ["packaged", "dev"],
  ] as const)("does not launch the %s %s build", (target, profile) => {
    expect(() => launchSpec(target, profile, { directory })).toThrow(
      `The ${target} ${profile} build is not a launch target`,
    );
  });

  it("requires the packaged app to exist; the dev bundles are scripts/dev.ts's to check", () => {
    expect(() => checkLaunchInputs(launchSpec("packaged", "test", { directory }), directory)).toThrow(
      "is missing: run `pnpm package:desktop` first",
    );
    expect(() => checkLaunchInputs(launchSpec("unpackaged", "dev", { directory }), directory)).not.toThrow();
  });

  it("names what a launched app reported", () => {
    expect(buildProfileMismatch("dev", "test").message).toBe(
      'The launched app reports build profile "dev", expected "test"',
    );
    expect(buildProfileMismatch(undefined, "test").message).toBe(
      'The launched app reports build profile none, expected "test"',
    );
  });
});

describe("files on disk", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "desktop launch "));
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("writes the dev manifest with the package's identity and the dev entry only", () => {
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: "desktop",
        version: "1.2.3",
        main: ".vite/test/main.cjs",
        scripts: { start: "node scripts/start.ts" },
        productName: "My Product",
      }),
    );
    const file = writeDevPackageJson(directory);
    expect(file).toBe(join(directory, ".vite", "dev", "package.json"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      name: "desktop",
      productName: "My Product",
      version: "1.2.3",
      main: "main.cjs",
    });
  });

  it("refuses a package without a product name", () => {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "desktop", version: "1.2.3" }));
    expect(() => writeDevPackageJson(directory)).toThrow("has no string productName");
  });

  it("requires the unpackaged bundles before checking the web build", () => {
    const desktopDir = join(directory, "apps", "desktop");
    const bundles = join(desktopDir, ".vite", "test");
    mkdirSync(bundles, { recursive: true });
    expect(() => checkUnpackagedBuild("test", desktopDir)).toThrow(
      `${join(".vite", "test", "main.cjs")} is missing: run \`pnpm build:desktop\` first`,
    );
    writeFileSync(join(bundles, "main.cjs"), "");
    writeFileSync(join(bundles, "preload.cjs"), "");
    writeFileSync(join(bundles, "utility.mjs"), `m={module:"/assets/entry.client-BECgCha7.js"}`);
    writeFileSync(join(bundles, WEB_SERVER_RECORD), JSON.stringify({ sha256: webServerDigest("server") }));
    mkdirSync(join(directory, "apps", "web", "build", "server"), { recursive: true });
    writeFileSync(join(directory, "apps", "web", "build", "server", "index.js"), "server");
    const assets = join(directory, "apps", "web", "build", "client", "assets");
    mkdirSync(assets, { recursive: true });
    expect(() => checkUnpackagedBuild("test", desktopDir)).toThrow("come from different web builds");
    writeFileSync(join(assets, "entry.client-BECgCha7.js"), "");
    expect(() => checkUnpackagedBuild("test", desktopDir)).not.toThrow();
  });
});
