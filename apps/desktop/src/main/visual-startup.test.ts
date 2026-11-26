import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { visualRecordKernel } from "@repo/shared";
import { expect, it, vi } from "vitest";

import type { Logger } from "./log.ts";
import type { createWindowRegistry } from "./window-registry.ts";
import { createAppWindow } from "./window.ts";

const fixture = vi.hoisted(() => ({
  directory: "",
  nativeTheme: { themeSource: "system", shouldUseDarkColors: true },
  construct: vi.fn<(options: Electron.BrowserWindowConstructorOptions) => void>(),
  registry: vi.fn<typeof createWindowRegistry>(),
  exit: vi.fn<(code: number) => void>(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => fixture.directory,
    getVersion: () => "1",
    requestSingleInstanceLock: () => true,
    commandLine: { hasSwitch: () => false },
    whenReady: () => Promise.resolve(),
    on: () => {},
    once: () => {},
    exit: fixture.exit,
  },
  BrowserWindow: function BrowserWindow(options: Electron.BrowserWindowConstructorOptions) {
    fixture.construct(options);
  },
  nativeTheme: fixture.nativeTheme,
  protocol: { registerSchemesAsPrivileged: () => {} },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: () => {},
      setDevicePermissionHandler: () => {},
    }),
  },
}));
vi.mock(import("@repo/shared"), async (original) => {
  const shared = await original();
  const defaults = { ...shared.VISUAL_DEFAULTS, colorScheme: "light" as const };
  return { ...shared, VISUAL_DEFAULTS: defaults, visualRecordKernel: shared.createVisualRecordKernel(defaults) };
});
vi.mock("~/main/dev-host.ts", () => ({ developmentHost: undefined }));
vi.mock("~/diagnostics/entry.ts", () => ({ selectMainRun: () => {} }));
vi.mock(import("./cookie-key.ts"), async (original) => ({
  ...(await original()),
  storeCookieKeyFirst: () => ({ kind: "none" as const }),
}));
vi.mock(import("./window-registry.ts"), () => ({ createWindowRegistry: fixture.registry }));

it.each(["missing", "dark"] as const)(
  "applies the %s disk mirror with a light product default before constructing windows",
  async (disk) => {
    vi.resetModules();
    fixture.registry.mockClear();
    fixture.construct.mockClear();
    fixture.nativeTheme.themeSource = "system";
    fixture.directory = mkdtempSync(join(tmpdir(), "visual-startup-"));
    const stop = new Error("Window options captured before starting the utility");
    fixture.registry.mockImplementationOnce(() => {
      throw stop;
    });
    const log = { info: () => {}, debug: () => {}, warn: () => {}, error: vi.fn<Logger["error"]>() };
    // The main entry installs process listeners and reads Electron's OS version.
    vi.stubGlobal("process", Object.assign(Object.create(process), { on: () => {}, getSystemVersion: () => "1" }));
    vi.stubGlobal("desktopBuildProfile", undefined);
    try {
      vi.spyOn(await import("./log.ts"), "createLogger").mockReturnValue(log);
      const stopped = new Promise<void>((resolve) => fixture.exit.mockImplementationOnce(() => resolve()));
      const raw =
        disk === "missing"
          ? null
          : visualRecordKernel.encode({
              version: 1,
              stamp: { t: 1, id: "disk" },
              preferences: { colorScheme: "dark" },
            });
      if (raw) writeFileSync(join(fixture.directory, "visual.json"), raw);
      await import("~/main.ts");
      await stopped;
      expect(log.error).toHaveBeenCalledExactlyOnceWith({ err: stop }, "startup failed");
      const [[options]] = fixture.registry.mock.calls;
      expect(options.chrome?.visualMirror.read()).toEqual({ record: raw, pending: false });
      expect(fixture.nativeTheme.themeSource).toBe(disk === "missing" ? "light" : "dark");
      createAppWindow(options);
      createAppWindow({ ...options, fixedAppearance: "dark" });
      expect(fixture.construct.mock.calls.map(([win]) => win.backgroundColor)).toEqual([
        disk === "missing" ? "#ffffff" : "#17191d",
        "#17191d",
      ]);
      expect(fixture.nativeTheme.themeSource).toBe(disk === "missing" ? "light" : "dark");
      expect(readdirSync(fixture.directory)).toEqual(disk === "missing" ? [] : ["visual.json"]);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  },
);
