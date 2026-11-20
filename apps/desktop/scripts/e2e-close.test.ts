import { expect, it, vi } from "vitest";

import { closeApplication } from "../e2e/desktop.ts";

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

it("terminates a still-running owned child through its handle if graceful close fails", async () => {
  const launcher = {
    pid: 101,
    exitCode: null,
    signalCode: null,
    kill: vi.fn<(signal?: NodeJS.Signals | number) => boolean>(() => true),
  };
  const failure = new Error("driver could not close");
  await expect(
    closeApplication(
      {
        close: async () => {
          throw failure;
        },
      },
      launcher,
      { pid: 101 },
    ),
  ).rejects.toBe(failure);
  expect(launcher.kill).toHaveBeenCalledWith("SIGKILL");
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
