import { EventEmitter } from "node:events";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { type ChildLike, startServerProcess } from "./server-process.ts";

const electron = vi.hoisted(() => ({ fork: vi.fn<(...args: unknown[]) => ChildLike>() }));
vi.mock("electron", () => ({ utilityProcess: { fork: electron.fork }, MessageChannelMain: vi.fn<() => void>() }));

const systemVersion = Object.getOwnPropertyDescriptor(process, "getSystemVersion");
beforeEach(() => {
  Object.defineProperty(process, "getSystemVersion", { configurable: true, value: () => "test-os" });
});
afterEach(() => {
  if (systemVersion) Object.defineProperty(process, "getSystemVersion", systemVersion);
  else Reflect.deleteProperty(process, "getSystemVersion");
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it.each([undefined, "development", "production"])(
  "forks the built web host in production with inherited NODE_ENV=%s",
  async (nodeEnv) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("LOG_LEVEL", "debug");
    vi.stubEnv("DESKTOP_BOOT_PROFILE", "1");
    const child = Object.assign(new EventEmitter(), {
      postMessage: vi.fn<ChildLike["postMessage"]>(),
      kill() {
        child.emit("exit", 0);
        return true;
      },
    });
    electron.fork.mockReturnValue(child);
    const server = startServerProcess({
      utilityPath: "/utility.mjs",
      clientDir: "/client",
      compileCacheDir: "/cache",
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      env: { NODE_ENV: "development", LOG_LEVEL: "trace", DESKTOP_E2E: "1" },
    });
    try {
      expect(electron.fork).toHaveBeenCalledWith("/utility.mjs", [], {
        stdio: "pipe",
        serviceName: "web-server",
        env: expect.objectContaining({
          NODE_ENV: "production",
          LOG_LEVEL: "trace",
          DESKTOP_BOOT_PROFILE: "1",
          DESKTOP_E2E: "1",
          NODE_COMPILE_CACHE: "/cache",
          CLIENT_DIR: "/client",
          WEB_SHELL: "desktop",
          WEB_SHELL_OS_VERSION: "test-os",
        }),
      });
    } finally {
      await server.shutdown();
    }
  },
);
