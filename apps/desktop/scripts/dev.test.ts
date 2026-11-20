import { ChildProcess } from "node:child_process";

import { expect, it, vi } from "vitest";

import { devElectron } from "./dev.ts";

it("coalesces rebuilds while the previous instance still holds the single-instance lock", () => {
  vi.useFakeTimers();
  try {
    const first = new ChildProcess();
    const second = new ChildProcess();
    const start = vi.fn<() => ChildProcess>().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const stop = vi.fn<(child: ChildProcess, signal?: NodeJS.Signals) => void>();
    let closing = false;
    const electron = devElectron(start, stop, () => closing);
    electron.restart();
    electron.restart();
    electron.restart();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    first.emit("exit", null, "SIGTERM");
    expect(electron.current).toBe(second);
    vi.advanceTimersByTime(3000);
    expect(stop).toHaveBeenCalledTimes(1);
    electron.restart();
    closing = true;
    second.emit("exit", 0, null);
    expect(start).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
