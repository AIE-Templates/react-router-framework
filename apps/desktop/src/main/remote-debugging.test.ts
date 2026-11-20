import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REMOTE_DEBUGGING_EXIT_CODE, REMOTE_DEBUGGING_REFUSED_MESSAGE } from "~/startup-signals.ts";

import { refuseRemoteDebugging } from "./remote-debugging.ts";

const native = vi.hoisted(() => ({
  hasSwitch: vi.fn<(name: string) => boolean>(() => false),
  exit: vi.fn<(code: number) => void>(),
  writeSync: vi.fn<(fd: number, data: string) => number>(() => 0),
}));
vi.mock("electron", () => ({ app: { commandLine: { hasSwitch: native.hasSwitch }, exit: native.exit } }));
vi.mock("node:fs", () => ({ writeSync: native.writeSync }));

/** What a test's stand-in for an exit throws where the real one would end the process. */
class ProcessEnded extends Error {}
/** In call order: the log line and every way out that was tried. */
let steps: string[];
/** The ways out that end the process in this test; the others return, as a deferred exit would. */
let effective: string[];
function wayOut(name: string) {
  return (...args: unknown[]) => {
    steps.push(`${name}(${args.join(", ")})`);
    if (effective.includes(name)) throw new ProcessEnded(name);
  };
}

const argv = process.argv;
const reallyExit = Object.getOwnPropertyDescriptor(process, "reallyExit");
// Every way out is replaced before any test runs the guard: the real ones would end the test run.
beforeEach(() => {
  steps = [];
  effective = ["app.exit"];
  native.hasSwitch.mockImplementation(() => false);
  native.writeSync.mockImplementation(() => steps.push("line"));
  native.exit.mockImplementation(wayOut("app.exit"));
  Object.defineProperty(process, "reallyExit", { configurable: true, writable: true, value: wayOut("reallyExit") });
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    wayOut("kill")(pid === process.pid ? "self" : pid, signal);
    return true;
  });
});
afterEach(() => {
  process.argv = argv;
  if (reallyExit) Object.defineProperty(process, "reallyExit", reallyExit);
  else Reflect.deleteProperty(process, "reallyExit");
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("lets a launch without a remote debugging switch through, silently", () => {
  process.argv = ["desktop", "--use-mock-keychain", "--user-data-dir=/tmp/profile"];
  refuseRemoteDebugging();
  expect(native.hasSwitch.mock.calls).toEqual([["remote-debugging-port"], ["remote-debugging-pipe"]]);
  expect(steps).toEqual([]);
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
    const stdout = vi.spyOn(process.stdout, "write");
    expect(() => refuseRemoteDebugging()).toThrow(ProcessEnded);
    expect(stdout).not.toHaveBeenCalled();
    expect(steps).toEqual(["line", `app.exit(${REMOTE_DEBUGGING_EXIT_CODE})`]);
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
  expect(() => refuseRemoteDebugging()).toThrow(ProcessEnded);
  expect(steps).toEqual([`app.exit(${REMOTE_DEBUGGING_EXIT_CODE})`]);
});

describe("when an exit does not end the process", () => {
  beforeEach(() => {
    process.argv = ["desktop", "--remote-debugging-port=9222"];
  });

  it("falls back to Node's own exit with the same status if Electron defers app.exit", () => {
    effective = ["reallyExit"];
    expect(() => refuseRemoteDebugging()).toThrow(ProcessEnded);
    expect(steps).toEqual([
      "line",
      `app.exit(${REMOTE_DEBUGGING_EXIT_CODE})`,
      `reallyExit(${REMOTE_DEBUGGING_EXIT_CODE})`,
    ]);
  });

  it("kills itself if that returns too", () => {
    effective = ["kill"];
    expect(() => refuseRemoteDebugging()).toThrow(ProcessEnded);
    expect(steps.slice(-1)).toEqual(["kill(self, SIGKILL)"]);
  });

  it("copes with a runtime that has no reallyExit", () => {
    Reflect.deleteProperty(process, "reallyExit");
    effective = ["kill"];
    expect(() => refuseRemoteDebugging()).toThrow(ProcessEnded);
    expect(steps).toEqual(["line", `app.exit(${REMOTE_DEBUGGING_EXIT_CODE})`, "kill(self, SIGKILL)"]);
  });

  it("never returns to the main entry, whatever happens: one log line, every way out tried in order", () => {
    effective = [];
    expect(() => refuseRemoteDebugging()).toThrow("The process survived its own exit");
    expect(steps).toEqual([
      "line",
      `app.exit(${REMOTE_DEBUGGING_EXIT_CODE})`,
      `reallyExit(${REMOTE_DEBUGGING_EXIT_CODE})`,
      "kill(self, SIGKILL)",
    ]);
  });
});
