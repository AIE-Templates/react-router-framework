import { spawn } from "node:child_process";
import { once } from "node:events";

import { expect, it, vi } from "vitest";

import { closeApplication } from "../e2e/desktop.ts";
import { listProcesses } from "./child-run.ts";

it("waits for graceful exit without signalling a PID that may already have been reused", async () => {
  const launcher = {
    pid: 101,
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn<(signal?: NodeJS.Signals | number) => boolean>(() => true),
  };
  const close = vi.fn<() => Promise<void>>(async () => {
    setTimeout(() => {
      launcher.exitCode = 0;
    }, 1);
  });
  const main = { pid: launcher.pid };
  await closeApplication({ close }, launcher, main);
  await closeApplication({ close }, launcher, main);
  expect(close).toHaveBeenCalledTimes(1);
  expect(launcher.kill).not.toHaveBeenCalled();
});

it("waits for the owned child to exit before propagating the graceful-close failure", async () => {
  const child = spawn(process.execPath, ["-e", 'console.log("ready"); setInterval(() => {}, 1000)'], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const exited = once(child, "exit");
  const failure = new Error("driver could not close");
  try {
    await once(child.stdout, "data");
    await expect(closeApplication({ close: () => Promise.reject(failure) }, child, { pid: child.pid! })).rejects.toBe(
      failure,
    );
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
});

it("retains the profile and reports the original failure if forced exit cannot be confirmed", async () => {
  vi.useFakeTimers();
  const keepProfile = vi.fn<() => void>();
  const launcher = {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    kill: vi.fn<(signal?: NodeJS.Signals | number) => boolean>(() => false),
  };
  const failure = new Error("driver could not close");
  try {
    const closed = closeApplication({ close: () => Promise.reject(failure) }, launcher, undefined, keepProfile);
    const outcome = closed.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await outcome).toBe(failure);
    expect(launcher.kill).toHaveBeenCalledWith("SIGKILL");
    expect(keepProfile).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it.skipIf(process.platform !== "win32")(
  "ignores a recycled Electron PID after its Windows launcher exits",
  async () => {
    const launcher = {
      pid: 101,
      exitCode: 0,
      signalCode: null,
      kill: vi.fn<(signal?: NodeJS.Signals | number) => boolean>(() => true),
    };
    const close = vi.fn<() => Promise<void>>(async () => {});
    // The live Vitest worker owns this PID, with a different creation time.
    await closeApplication({ close }, launcher, { pid: process.pid, startedAt: 0 });
    expect(close).not.toHaveBeenCalled();
    expect(launcher.kill).not.toHaveBeenCalled();
  },
);

it.skipIf(process.platform === "win32")(
  "reaps the Playwright group after close times out and leaves an independent launch alive",
  async () => {
    const awake = "setTimeout(() => {}, 30000)";
    const fixture = `const cp = require("node:child_process"); console.log(cp.spawn(process.execPath, ["-e", ${JSON.stringify(awake)}], {stdio:"ignore"}).pid)`;
    const other = spawn(process.execPath, ["-e", awake], { detached: true, stdio: "ignore" });
    const child = spawn(process.execPath, ["-e", fixture], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    try {
      const [line] = await once(child.stdout, "data");
      const helper = Number(String(line).trim());
      expect(helper).toBeGreaterThan(0);
      await expect(closeApplication({ close: () => new Promise<void>(() => {}) }, child)).rejects.toThrow(
        "within 10 seconds",
      );
      expect(listProcesses().some((item) => item.pid === helper && !item.zombie)).toBe(false);
      expect(process.kill(other.pid!, 0)).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, "SIGKILL");
      other.kill("SIGKILL");
    }
  },
  20000,
);
