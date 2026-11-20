import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkUnpackagedBuild,
  reportedBuildProfile,
  verifyBuildProfile,
  withBuildProfileCheck,
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
    await new Promise((resolve) => setImmediate(resolve));
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

/** Spawns Node printing `output`, consuming its stdout the way Playwright does, and waits for it to exit. */
const driverLaunch = (output: string) => async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  const child = spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(output)})`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  createInterface({ input: child.stdout }).on("line", () => {});
  await once(child, "close");
  return child;
};

describe("launch through a driver that reads stdout itself", () => {
  it("checks the profile of the process the driver spawned", async () => {
    const abort = vi.fn<() => Promise<void>>(async () => {});
    const child = await withBuildProfileCheck(
      process.execPath,
      "test",
      driverLaunch(`${startupLine("test")}\n`),
      abort,
    );
    expect(child.exitCode).toBe(0);
    expect(abort).not.toHaveBeenCalled();
  });

  it("stops what was launched when the profile differs", async () => {
    const abort = vi.fn<() => Promise<void>>(async () => {});
    await expect(
      withBuildProfileCheck(process.execPath, "test", driverLaunch(`${startupLine("dev")}\n`), abort),
    ).rejects.toThrow('reports build profile "dev", expected "test"');
    expect(abort).toHaveBeenCalledOnce();
  });

  it("fails when it never saw the executable being spawned", async () => {
    const abort = vi.fn<() => Promise<void>>(async () => {});
    await expect(
      withBuildProfileCheck("/nonexistent/Electron", "test", driverLaunch(`${startupLine("test")}\n`), abort),
    ).rejects.toThrow("Did not see /nonexistent/Electron being spawned");
    expect(abort).toHaveBeenCalledOnce();
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
      `${join(".vite/test", "main.cjs")} is missing: run \`pnpm build:desktop\` first`,
    );
    writeFileSync(join(bundles, "main.cjs"), "");
    writeFileSync(join(bundles, "preload.cjs"), "");
    writeFileSync(join(bundles, "utility.mjs"), `m={module:"/assets/entry.client-BECgCha7.js"}`);
    const assets = join(directory, "apps", "web", "build", "client", "assets");
    mkdirSync(assets, { recursive: true });
    expect(() => checkUnpackagedBuild("test", desktopDir)).toThrow("come from different web builds");
    writeFileSync(join(assets, "entry.client-BECgCha7.js"), "");
    expect(() => checkUnpackagedBuild("test", desktopDir)).not.toThrow();
  });
});
