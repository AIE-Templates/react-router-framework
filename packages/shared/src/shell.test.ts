import { describe, expect, it } from "vitest";

import { shellFromEnv } from "./shell.ts";

describe("shellFromEnv", () => {
  it("is web unless WEB_SHELL is desktop", () => {
    expect(shellFromEnv({})).toEqual({ kind: "web" });
    expect(shellFromEnv({ WEB_SHELL: "web", WEB_SHELL_PLATFORM: "darwin" })).toEqual({ kind: "web" });
    expect(shellFromEnv({ WEB_SHELL: "Desktop", WEB_SHELL_PLATFORM: "darwin" })).toEqual({ kind: "web" });
  });

  it("describes the desktop shell", () => {
    expect(shellFromEnv({ WEB_SHELL: "desktop", WEB_SHELL_PLATFORM: "darwin", WEB_SHELL_OS_VERSION: "26.1" })).toEqual({
      kind: "desktop",
      platform: "darwin",
      osVersion: "26.1",
    });
    expect(
      shellFromEnv({
        WEB_SHELL: "desktop",
        WEB_SHELL_PLATFORM: "linux",
        WEB_SHELL_OS_VERSION: "6.8.0",
        WEB_SHELL_DESKTOP_ENV: "GNOME",
        WEB_SHELL_SESSION_TYPE: "wayland",
      }),
    ).toEqual({ kind: "desktop", platform: "linux", osVersion: "6.8.0", desktopEnv: "GNOME", sessionType: "wayland" });
  });

  it("is web for a missing or unknown platform", () => {
    expect(shellFromEnv({ WEB_SHELL: "desktop" })).toEqual({ kind: "web" });
    expect(shellFromEnv({ WEB_SHELL: "desktop", WEB_SHELL_PLATFORM: "android" })).toEqual({ kind: "web" });
  });

  it("defaults the OS version to an empty string", () => {
    expect(shellFromEnv({ WEB_SHELL: "desktop", WEB_SHELL_PLATFORM: "win32" })).toEqual({
      kind: "desktop",
      platform: "win32",
      osVersion: "",
    });
  });
});
