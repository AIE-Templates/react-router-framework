import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { packagedExecutable } from "../e2e/packaged-path.ts";
import { WEB_SERVER_RECORD, webServerDigest } from "./check-web-build.ts";
import { FUSE_NAMES, FUSES } from "./fuses.ts";
import {
  buildProfileMismatch,
  checkLaunchInputs,
  checkUnpackagedBuild,
  credentialStoreSwitches,
  electronBinary,
  freshUserDataDir,
  launchLocation,
  launchSpec,
  linuxSandboxBlocker,
  reportedBuildProfile,
  type SandboxProbe,
  sandboxSwitches,
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

  /** What every test launch on this machine adds after its user data directory. */
  const platformSwitches = (command: string) => [
    ...sandboxSwitches(process.platform, command),
    `--user-data-dir=${resolve(directory, "data")}`,
    ...credentialStoreSwitches(process.platform),
  ];

  it("starts the unpackaged test bundles as `electron .` in apps/desktop, on the user data directory given", () => {
    const userDataDir = join(directory, "data");
    expect(launchSpec("unpackaged", "test", { directory, userDataDir })).toEqual({
      target: "unpackaged",
      profile: "test",
      command: electronBinary(),
      args: [".", ...platformSwitches(electronBinary())],
      cwd: directory,
      // Nothing about the user data directory: only the dev build reads DESKTOP_USER_DATA_SUFFIX.
      env: { NODE_ENV: "production" },
      processDir: electronProcessDir(),
    });
  });

  it("refuses a test launch without a user data directory, and gives none to dev", () => {
    expect(() => launchSpec("unpackaged", "test", { directory })).toThrow(
      "A test launch needs a user data directory of its own",
    );
    expect(() => launchSpec("unpackaged", "dev", { directory, userDataDir: join(directory, "data") })).toThrow(
      "Only test launches take a user data directory",
    );
  });

  it("starts the dev bundles on their directory, with DESKTOP_USER_DATA_SUFFIX left to the caller", () => {
    const spec = launchSpec("unpackaged", "dev", { directory });
    expect(spec).toMatchObject({
      command: electronBinary(),
      args: [join(directory, ".vite", "dev"), ...sandboxSwitches(process.platform, electronBinary())],
      cwd: directory,
      env: { NODE_ENV: "development" },
    });
    expect(spec.args.some((arg) => arg.startsWith("--user-data-dir"))).toBe(false);
    expect(spec.env).not.toHaveProperty("DESKTOP_USER_DATA_SUFFIX");
  });

  it("starts the packaged test app from out/test, or the executable named", () => {
    const userDataDir = join(directory, "data");
    const packaged = resolve(
      packagedExecutable(join(directory, "out", "test"), metadata, process.platform, process.arch),
    );
    expect(launchSpec("packaged", "test", { directory, userDataDir })).toMatchObject({
      command: packaged,
      args: platformSwitches(packaged),
      cwd: dirname(packaged),
      env: { NODE_ENV: "production" },
    });
    const other = join(directory, "elsewhere", "Desktop");
    expect(launchSpec("packaged", "test", { directory, executable: other, userDataDir })).toMatchObject({
      command: other,
      processDir: dirname(other),
    });
    expect(launchLocation("packaged", "test", { directory, executable: other })).toEqual({
      target: "packaged",
      profile: "test",
      command: other,
      processDir: dirname(other),
    });
  });

  it.each([
    ["unpackaged", "release"],
    ["packaged", "release"],
    ["packaged", "dev"],
  ] as const)("does not launch the %s %s build", (target, profile) => {
    expect(() => launchSpec(target, profile, { directory, userDataDir: join(directory, "data") })).toThrow(
      `The ${target} ${profile} build is not a launch target`,
    );
  });

  it("requires the packaged app to exist; the dev bundles are scripts/dev.ts's to check", async () => {
    await expect(checkLaunchInputs(launchLocation("packaged", "test", { directory }), directory)).rejects.toThrow(
      "is missing: run `pnpm package:desktop` first",
    );
    await expect(checkLaunchInputs(launchLocation("unpackaged", "dev", { directory }), directory)).resolves.toBe(
      undefined,
    );
  });

  /** A file with a fuse wire, the way `getCurrentFuseWire` finds one in an Electron binary. */
  function fakeBinary(name: string, fuses: Record<string, boolean>): string {
    const wire = FUSE_NAMES.map((fuse) => (fuses[fuse] ? 0x31 : 0x30));
    const file = join(directory, name);
    writeFileSync(
      file,
      Buffer.concat([
        Buffer.from("padding before the wire "),
        Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"),
        Buffer.from([1, wire.length, ...wire]),
        Buffer.from(" and after"),
      ]),
    );
    return file;
  }

  it("launches a packaged app only when its fuses read back as the test profile's", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const fused = fakeBinary("fused", FUSES.test);
      await expect(checkLaunchInputs(launchLocation("packaged", "test", { executable: fused }))).resolves.toBe(
        undefined,
      );
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("EnableNodeCliInspectArguments=true"));
      // A package whose afterPack did not run keeps Electron's defaults.
      const unfused = fakeBinary("unfused", {
        RunAsNode: true,
        EnableCookieEncryption: false,
        EnableNodeOptionsEnvironmentVariable: true,
        EnableNodeCliInspectArguments: true,
        EnableEmbeddedAsarIntegrityValidation: false,
        OnlyLoadAppFromAsar: false,
      });
      await expect(checkLaunchInputs(launchLocation("packaged", "test", { executable: unfused }))).rejects.toThrow(
        /not those of the test profile.*RunAsNode is true, expected false; EnableCookieEncryption is false, expected true/,
      );
      // So does the release package: its inspect fuse is off.
      const release = fakeBinary("release", FUSES.release);
      await expect(checkLaunchInputs(launchLocation("packaged", "test", { executable: release }))).rejects.toThrow(
        "EnableNodeCliInspectArguments is false, expected true",
      );
    } finally {
      stdout.mockRestore();
    }
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

describe("credential store", () => {
  it("keeps test launches off the macOS keychain and the Linux keyring; Windows needs nothing", () => {
    expect(credentialStoreSwitches("darwin")).toEqual(["--use-mock-keychain"]);
    expect(credentialStoreSwitches("linux")).toEqual(["--password-store=basic"]);
    expect(credentialStoreSwitches("win32")).toEqual([]);
  });

  it("makes a fresh user data directory per call", () => {
    const first = freshUserDataDir("unit");
    const second = freshUserDataDir("unit");
    try {
      expect(first).not.toBe(second);
      expect(readdirSync(first)).toEqual([]);
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });
});

describe("Linux sandbox", () => {
  const executable = join("/opt", "app", "desktop");
  const helper = join("/opt", "app", "chrome-sandbox");
  const probe = (sysctls: Record<string, string>, helperStat?: { uid: number; mode: number }): SandboxProbe => ({
    sysctl: (name) => sysctls[name],
    stat: (path) => (path === helper ? helperStat : undefined),
  });
  const restricted = { "kernel.apparmor_restrict_unprivileged_userns": "1" };

  it("leaves the sandbox on where user namespaces are allowed, whatever the helper", () => {
    expect(linuxSandboxBlocker(executable, probe({}))).toBeUndefined();
    expect(
      linuxSandboxBlocker(
        executable,
        probe({
          "kernel.apparmor_restrict_unprivileged_userns": "0",
          "kernel.unprivileged_userns_clone": "1",
          "user.max_user_namespaces": "63000",
        }),
      ),
    ).toBeUndefined();
  });

  it("leaves the sandbox on where namespaces are forbidden but the helper is root-owned 4755", () => {
    expect(linuxSandboxBlocker(executable, probe(restricted, { uid: 0, mode: 0o104755 }))).toBeUndefined();
  });

  it.each([
    [restricted, "kernel.apparmor_restrict_unprivileged_userns=1"],
    [{ "kernel.unprivileged_userns_clone": "0" }, "kernel.unprivileged_userns_clone=0"],
    [{ "user.max_user_namespaces": "0" }, "user.max_user_namespaces=0"],
  ])("says why it cannot start: %j", (sysctls, reason) => {
    const missing = linuxSandboxBlocker(executable, probe(sysctls));
    expect(missing).toContain(reason);
    expect(missing).toContain(`${helper} is missing`);
    expect(linuxSandboxBlocker(executable, probe(sysctls, { uid: 1000, mode: 0o104755 }))).toContain(
      `${helper} is owned by uid 1000 with mode 4755`,
    );
    expect(linuxSandboxBlocker(executable, probe(sysctls, { uid: 0, mode: 0o100755 }))).toContain(
      `${helper} is owned by uid 0 with mode 755`,
    );
  });

  it("adds --no-sandbox only on Linux and only when the sandbox cannot start, saying so once", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(sandboxSwitches("darwin", executable, probe(restricted))).toEqual([]);
      expect(sandboxSwitches("win32", executable, probe(restricted))).toEqual([]);
      expect(sandboxSwitches("linux", executable, probe({}))).toEqual([]);
      expect(sandboxSwitches("linux", executable, probe(restricted, { uid: 0, mode: 0o104755 }))).toEqual([]);
      expect(stderr).not.toHaveBeenCalled();
      const blocked = probe({ "kernel.unprivileged_userns_clone": "0" }, { uid: 501, mode: 0o100755 });
      expect(sandboxSwitches("linux", executable, blocked)).toEqual(["--no-sandbox"]);
      expect(sandboxSwitches("linux", executable, blocked)).toEqual(["--no-sandbox"]);
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledWith(
        expect.stringMatching(/^launch: passing --no-sandbox: .*unprivileged_userns_clone=0.*uid 501 with mode 755/),
      );
    } finally {
      stderr.mockRestore();
    }
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
