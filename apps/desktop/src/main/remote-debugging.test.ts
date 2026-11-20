import { afterEach, expect, it, vi } from "vitest";

import { REMOTE_DEBUGGING_EXIT_CODE, REMOTE_DEBUGGING_REFUSED_MESSAGE } from "~/startup-signals.ts";

import { refuseRemoteDebugging } from "./remote-debugging.ts";

const native = vi.hoisted(() => ({
  hasSwitch: vi.fn<(name: string) => boolean>(() => false),
  exit: vi.fn<(code: number) => void>(),
  writeSync: vi.fn<(fd: number, data: string) => number>(() => 0),
}));
vi.mock("electron", () => ({ app: { commandLine: { hasSwitch: native.hasSwitch }, exit: native.exit } }));
vi.mock("node:fs", () => ({ writeSync: native.writeSync }));

const argv = process.argv;
afterEach(() => {
  process.argv = argv;
  vi.clearAllMocks();
  native.hasSwitch.mockImplementation(() => false);
  native.writeSync.mockImplementation(() => 0);
});

it("lets a launch without a remote debugging switch through, silently", () => {
  process.argv = ["desktop", "--use-mock-keychain", "--user-data-dir=/tmp/profile"];
  refuseRemoteDebugging();
  expect(native.hasSwitch.mock.calls).toEqual([["remote-debugging-port"], ["remote-debugging-pipe"]]);
  expect(native.exit).not.toHaveBeenCalled();
  expect(native.writeSync).not.toHaveBeenCalled();
});

it.each([
  { source: "argv", args: ["--remote-debugging-port=9222"], chromium: undefined, found: "remote-debugging-port" },
  { source: "argv", args: ["--remote-debugging-pipe"], chromium: undefined, found: "remote-debugging-pipe" },
  { source: "Chromium", args: [], chromium: "remote-debugging-port", found: "remote-debugging-port" },
  { source: "Chromium", args: [], chromium: "remote-debugging-pipe", found: "remote-debugging-pipe" },
])(
  "refuses $found seen by $source: one synchronous log line, then its own exit status",
  ({ args, chromium, found }) => {
    process.argv = ["desktop", ...args];
    native.hasSwitch.mockImplementation((name) => name === chromium);
    const order: string[] = [];
    native.writeSync.mockImplementation(() => order.push("line"));
    native.exit.mockImplementation(() => void order.push("exit"));
    const stdout = vi.spyOn(process.stdout, "write");
    try {
      refuseRemoteDebugging();
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
    expect(order).toEqual(["line", "exit"]);
    expect(native.exit).toHaveBeenCalledExactlyOnceWith(REMOTE_DEBUGGING_EXIT_CODE);
    const [fd, line] = native.writeSync.mock.calls[0];
    expect(fd).toBe(1);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toMatchObject({
      level: "error",
      process: "main",
      switch: found,
      msg: REMOTE_DEBUGGING_REFUSED_MESSAGE,
    });
  },
);

it("still exits when stdout cannot be written", () => {
  process.argv = ["desktop", "--remote-debugging-pipe"];
  native.writeSync.mockImplementation(() => {
    throw new Error("EBADF");
  });
  refuseRemoteDebugging();
  expect(native.exit).toHaveBeenCalledExactlyOnceWith(REMOTE_DEBUGGING_EXIT_CODE);
});
