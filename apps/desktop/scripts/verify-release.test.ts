import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expect, it, vi } from "vitest";

import * as powershell from "./powershell.ts";
import { finish, launch } from "./verify-release.ts";

const location = { command: process.execPath, processDir: dirname(process.execPath) };

it("reports ENOENT for a missing release executable", async () => {
  const command = join(dirname(process.execPath), "missing-verify-release-fixture");
  await expect(launch(command, [], location, { deadlineMs: 100 })).rejects.toMatchObject({ code: "ENOENT" });
});

it.skipIf(process.platform === "win32")("reports EACCES for a non-executable release file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "verify-spawn-"));
  try {
    const command = join(directory, "app");
    writeFileSync(command, "", { mode: 0o600 });
    await expect(launch(command, [], location, { deadlineMs: 100 })).rejects.toMatchObject({ code: "EACCES" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "finishes verification even when the process group cannot be stopped",
  async () => {
    const started = await launch(process.execPath, ["-e", "setInterval(() => {}, 1000)"], location, {
      deadlineMs: 100,
      stopGraceMs: 100,
    });
    const kill = process.kill.bind(process);
    const stop = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -started.app.pid) throw Object.assign(new Error("Cannot stop fixture"), { code: "EPERM" });
      return kill(pid, signal);
    });
    try {
      await expect(started.app.exited).resolves.toMatchObject({ timedOut: true });
      expect(stop).toHaveBeenCalledWith(-started.app.pid, "SIGKILL");
      expect(started.app.isRunning()).toBe(true);
      await expect(finish(started)).rejects.toThrow("Could not confirm exit");
    } finally {
      stop.mockRestore();
      kill(started.app.pid, "SIGKILL");
      await vi.waitFor(() => expect(started.app.isRunning()).toBe(false));
      await finish(started);
    }
  },
);

it("keeps an unconfirmed helper tracked until a later stop succeeds", async () => {
  const script = `
    const { spawn } = require("node:child_process");
    const helper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      detached: process.platform === "win32", stdio: "ignore",
    });
    console.log(helper.pid);
    helper.unref();
  `;
  const started = await launch(process.execPath, ["-e", script], location, { deadlineMs: 10000 });
  await started.app.exited;
  const pid = Number(started.app.stdout().trim());
  expect(pid).toBeGreaterThan(0);
  const kill = process.kill.bind(process);
  const windowsProcess = powershell.windowsProcess;
  const posix = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
    if (target === pid && signal === "SIGKILL") throw Object.assign(new Error("Access denied"), { code: "EPERM" });
    return kill(target, signal);
  });
  const windows = vi.spyOn(powershell, "windowsProcess").mockImplementation((item, action, timeout) => {
    if (item.pid === pid && action === "kill") return false;
    return windowsProcess(item, action, timeout);
  });
  try {
    await expect(finish(started, [], 100)).rejects.toThrow(
      `Could not confirm exit of helpers after termination: ${pid}`,
    );
    expect(kill(pid, 0)).toBe(true);
  } finally {
    posix.mockRestore();
    windows.mockRestore();
    const stopped = await finish(started, [], 250);
    expect(stopped.map((item) => item.pid)).toContain(pid);
  }
}, 30000);
