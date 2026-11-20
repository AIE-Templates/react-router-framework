import { describe, expect, it } from "vitest";

import {
  MAIN_WINDOW_READY_MESSAGE,
  REMOTE_DEBUGGING_EXIT_CODE,
  REMOTE_DEBUGGING_REFUSED_MESSAGE,
  remoteDebuggingSwitch,
} from "./startup-signals.ts";

const none = () => false;

describe("remoteDebuggingSwitch", () => {
  it.each([
    [["--remote-debugging-port=9222"], "remote-debugging-port"],
    [["--remote-debugging-port"], "remote-debugging-port"],
    [["--remote-debugging-port", "9222"], "remote-debugging-port"],
    [["--remote-debugging-port=0"], "remote-debugging-port"],
    [["-remote-debugging-port=9222"], "remote-debugging-port"],
    [["--remote-debugging-pipe"], "remote-debugging-pipe"],
    [["--remote-debugging-pipe=cbor"], "remote-debugging-pipe"],
    [["-remote-debugging-pipe"], "remote-debugging-pipe"],
    [["--user-data-dir=/tmp/x", "--", "--remote-debugging-pipe"], "remote-debugging-pipe"],
  ] as const)("finds %j in argv", (args, expected) => {
    expect(remoteDebuggingSwitch(none, ["/Applications/Desktop.app/Contents/MacOS/Desktop", ...args], "darwin")).toBe(
      expected,
    );
    expect(remoteDebuggingSwitch(none, ["desktop", ...args], "linux")).toBe(expected);
    expect(remoteDebuggingSwitch(none, ["Desktop.exe", ...args], "win32")).toBe(expected);
  });

  it.each([
    [[]],
    [["--use-mock-keychain", "--user-data-dir=/tmp/remote-debugging-port"]],
    [["--remote-debugging-ports=9222"]],
    [["--no-remote-debugging-port"]],
    [["remote-debugging-port=9222"]],
    [["--remote-debugging-address=0.0.0.0"]],
    [["/remote-debugging-port=9222"]],
    [["--Remote-Debugging-Port=9222"]],
  ] as const)("finds nothing in %j outside Windows", (args) => {
    expect(remoteDebuggingSwitch(none, ["desktop", ...args], "darwin")).toBeUndefined();
    expect(remoteDebuggingSwitch(none, ["desktop", ...args], "linux")).toBeUndefined();
  });

  it("also accepts Windows' slash prefix and any letter case there", () => {
    expect(remoteDebuggingSwitch(none, ["Desktop.exe", "/remote-debugging-port=9222"], "win32")).toBe(
      "remote-debugging-port",
    );
    expect(remoteDebuggingSwitch(none, ["Desktop.exe", "--Remote-Debugging-Pipe"], "win32")).toBe(
      "remote-debugging-pipe",
    );
  });

  it("trusts Chromium's own view of the command line when argv shows nothing", () => {
    const seen: string[] = [];
    const hasSwitch = (name: string) => {
      seen.push(name);
      return name === "remote-debugging-pipe";
    };
    expect(remoteDebuggingSwitch(hasSwitch, ["desktop"], "linux")).toBe("remote-debugging-pipe");
    expect(seen).toEqual(["remote-debugging-port", "remote-debugging-pipe"]);
  });
});

it("keeps the signals other tools match on stable", () => {
  // scripts that verify a release package compare against these values: change them deliberately.
  expect(REMOTE_DEBUGGING_EXIT_CODE).toBe(97);
  expect(REMOTE_DEBUGGING_REFUSED_MESSAGE).toBe("remote debugging refused");
  expect(MAIN_WINDOW_READY_MESSAGE).toBe("main window loaded and shown");
});
