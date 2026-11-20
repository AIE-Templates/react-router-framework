import { ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { linuxSandboxBlocker, packagedBinary } from "./launch.ts";
import { startRelease } from "./start.ts";

vi.mock("node:child_process", { spy: true });
vi.mock("node:fs", { spy: true });
vi.mock("./launch.ts", { spy: true });

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function fixture() {
  const executable = join("out", "release", "app");
  vi.mocked(packagedBinary).mockReturnValue(executable);
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(linuxSandboxBlocker).mockReturnValue(undefined);
  const child = new ChildProcess();
  vi.mocked(spawn).mockReturnValue(child);
  return { child, executable };
}

it.each([[], ["--user-data-dir=directory with spaces", "--extra"]].map((args) => ({ args })))(
  "launches release with exactly the supplied arguments: $args",
  async ({ args }) => {
    const { child, executable } = fixture();
    const finished = startRelease(args);
    expect(packagedBinary).toHaveBeenCalledWith(undefined, "release");
    expect(spawn).toHaveBeenCalledWith(executable, args, { cwd: join("out", "release"), stdio: "inherit" });
    child.emit("exit", 17, null);
    await expect(finished).resolves.toBe(17);
  },
);

it("reports the public packaging command if the app is missing", async () => {
  fixture();
  vi.mocked(existsSync).mockReturnValue(false);
  await expect(startRelease([])).rejects.toThrow("pnpm package:desktop");
  expect(spawn).not.toHaveBeenCalled();
});

it.runIf(process.platform === "linux")("refuses a blocked sandbox even with an explicit switch", async () => {
  fixture();
  vi.mocked(linuxSandboxBlocker).mockReturnValue("sandbox unavailable");
  await expect(startRelease(["--no-sandbox"])).rejects.toThrow("sandbox unavailable");
  expect(spawn).not.toHaveBeenCalled();
});

it.skipIf(process.platform === "win32")("returns shell status for signal termination", async () => {
  const { child } = fixture();
  const finished = startRelease([]);
  child.emit("exit", null, "SIGTERM");
  await expect(finished).resolves.toBe(143);
});

it("reports a failed spawn", async () => {
  const { child } = fixture();
  const finished = startRelease([]);
  child.emit("error", new Error("EACCES"));
  await expect(finished).rejects.toThrow("EACCES");
});
