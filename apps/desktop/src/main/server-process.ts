import {
  type AckCoalesceOptions,
  createPortFetch,
  type ElectronPortLike,
  fromElectronPort,
  type PortFetch,
  type PortStats,
} from "@repo/port-fetch";
import { MessageChannelMain, utilityProcess } from "electron";

import { PORT_ACK_COALESCE } from "../port-options.ts";
import type { Logger } from "./log.ts";

export interface ServerProcessOptions {
  /** `.vite/build/utility.mjs`. */
  utilityPath: string;
  /** The web client build: `resources/client` when packaged, `apps/web/build/client` otherwise. */
  clientDir: string;
  /** Node's compile cache directory for the utility (`NODE_COMPILE_CACHE`), covering its own bundle. */
  compileCacheDir?: string;
  log: Logger;
  /** The utility's own uptime when it reported ready, in milliseconds (its boot time). */
  onUtilityBoot?: (ms: number) => void;
  /** Called after the utility came back from an unexpected exit, so the window can reload. */
  onRestart?: () => void;
  /** Called at spawn and at readiness, for the boot profile. */
  onSpawn?: () => void;
  onReady?: () => void;
  /**
   * Ack coalescing on the main end of the port; `false` turns it off. Defaults to
   * `PORT_ACK_COALESCE`. The utility end follows `DESKTOP_PORT_ACK_COALESCE` in `env`, which the
   * caller sets to match.
   */
  ackCoalesce?: AckCoalesceOptions | false;
  /** Extra variables for the utility's environment, over the inherited ones. */
  env?: Record<string, string>;
  /** Lifecycle facts for the window recovery coordinator; includes the restart backoff period. */
  onLifecycle?: (event: { generation: number; state: "starting" | "ready" | "failed"; restarted: boolean }) => void;
}

export interface ServerProcess {
  /** Sends `request` to the server once it is ready (also across restarts). */
  fetch: PortFetch;
  /** Resolves when the current utility process has started serving. */
  ready(): Promise<void>;
  /** Asks the utility to close, then kills it if it lingers. No instance is started afterwards. */
  shutdown(): Promise<void>;
  /** For tests and diagnostics. */
  readonly state: ServerState;
  /** The current connection's client-side port-fetch counters, when there is one (diagnostics, the benchmark). */
  stats(): PortStats | undefined;
}

export type ServerState = "idle" | "starting" | "running" | "stopping" | "stopped";

/** What this module uses of Electron's `UtilityProcess`, so tests can substitute a fake. */
export interface ChildLike {
  on(event: "spawn", listener: () => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  on(event: "message", listener: (message: unknown) => void): unknown;
  postMessage(message: unknown, transfer?: unknown[]): void;
  kill(): boolean;
}

/** What this module uses of a `MessagePortMain`: what port-fetch's adapter needs. */
export type PortMainLike = ElectronPortLike;

/** Electron pieces behind the state machine, replaceable in tests. */
export interface ServerProcessDeps {
  /** Forks the utility with its environment (built from the options in Electron). */
  fork(): ChildLike;
  channel(): { port1: PortMainLike; port2: PortMainLike };
  createFetch(port2: PortMainLike): PortFetch;
}

/** fork → spawn → ready must complete within this; otherwise the instance is killed and retried. */
export const STARTUP_TIMEOUT_MS = 20_000;
export const SHUTDOWN_GRACE_MS = 3_000;
/**
 * Pre-header cancellation does not reach the utility, so the wait for response headers is bounded.
 * Nothing bounds the body: SSE and slow downloads stream for as long as they need.
 */
export const REQUEST_HEADERS_TIMEOUT_MS = 60_000;
const RESTART_BASE_MS = 250;
export const RESTART_MAX_MS = 5_000;

function electronDeps(options: ServerProcessOptions): ServerProcessDeps {
  const env = (): Record<string, string> => ({
    ...stringEnv(process.env),
    NODE_ENV: process.env.NODE_ENV ?? "production",
    ...(options.compileCacheDir ? { NODE_COMPILE_CACHE: options.compileCacheDir } : {}),
    CLIENT_DIR: options.clientDir,
    WEB_SHELL: "desktop",
    WEB_SHELL_PLATFORM: process.platform,
    WEB_SHELL_OS_VERSION: process.getSystemVersion(),
    ...(process.platform === "linux"
      ? {
          WEB_SHELL_DESKTOP_ENV: process.env.XDG_CURRENT_DESKTOP ?? "",
          WEB_SHELL_SESSION_TYPE: process.env.XDG_SESSION_TYPE ?? "",
        }
      : {}),
    ...options.env,
  });
  const ackCoalesce = options.ackCoalesce ?? PORT_ACK_COALESCE;
  return {
    fork() {
      const child = utilityProcess.fork(options.utilityPath, [], {
        stdio: "pipe",
        serviceName: "web-server",
        env: env(),
      });
      // The utility logs JSON lines of its own; pass them through untouched.
      child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
      child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
      return child;
    },
    channel: () => new MessageChannelMain(),
    // Only the wait for response headers is bounded: bodies (SSE, downloads) stream as long as needed.
    createFetch: (port2) =>
      createPortFetch(fromElectronPort(port2), {
        headersTimeoutMs: REQUEST_HEADERS_TIMEOUT_MS,
        ...(ackCoalesce ? { ackCoalesce } : {}),
      }),
  };
}

interface Instance {
  generation: number;
  child: ChildLike;
  spawned: boolean;
  fetch?: PortFetch;
  port2?: PortMainLike;
  ready: Promise<void>;
  settleReady: { resolve: () => void; reject: (err: Error) => void };
  readySettled: boolean;
  exited: boolean;
  startupTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Runs the web server (`createWebApp()`) in a utility process and talks to it over a MessagePortMain
 * through @repo/port-fetch. One state machine owns the instance, the in-flight start, the restart
 * timer and the stop: at most one utility process exists at a time, an unexpected exit or a startup
 * timeout schedules exactly one restart with backoff, and after `shutdown()` nothing starts again.
 */
export function startServerProcess(
  options: ServerProcessOptions,
  deps: ServerProcessDeps = electronDeps(options),
): ServerProcess {
  const { log } = options;
  let state: ServerState = "idle";
  let instance: Instance | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let restarts = 0;
  let generations = 0;
  /** The one stop in progress (or finished); every `shutdown()` call shares it. */
  let stopping: Promise<void> | undefined;
  const isStopping = () => state === "stopping" || state === "stopped";

  /** Drops `inst` as the current instance (its port, timer and ready promise), if it still is. */
  const retire = (inst: Instance, reason: Error) => {
    clearTimeout(inst.startupTimer);
    inst.port2?.close();
    if (!inst.readySettled) {
      inst.readySettled = true;
      inst.settleReady.reject(reason);
    }
    if (instance === inst) {
      instance = undefined;
      if (state === "starting" || state === "running") state = "idle";
    }
  };

  const scheduleRestart = (why: string) => {
    if (isStopping() || restartTimer !== undefined || instance !== undefined) return;
    restarts++;
    options.onLifecycle?.({ generation: generations + 1, state: "starting", restarted: true });
    const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** Math.min(restarts, 5));
    log.error({ restarts, delayMs: delay }, `server process ${why}, restarting`);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      void start().then(
        () => options.onRestart?.(),
        (err: unknown) => log.error({ err }, "server process restart failed"),
      );
    }, delay);
  };

  const spawn = (): Instance => {
    const settle = { resolve: () => {}, reject: (_err: Error) => {} };
    const ready = new Promise<void>((resolve, reject) => {
      settle.resolve = resolve;
      settle.reject = reject;
    });
    ready.catch(() => {});
    const generation = ++generations;
    options.onLifecycle?.({ generation, state: "starting", restarted: generation > 1 });
    const inst: Instance = {
      generation,
      child: deps.fork(),
      spawned: false,
      ready,
      settleReady: settle,
      readySettled: false,
      exited: false,
    };
    const current = () => instance === inst;

    inst.startupTimer = setTimeout(() => {
      if (!current() || inst.readySettled) return;
      log.error({ generation: inst.generation }, "server process did not become ready in time, killing it");
      retire(inst, new Error("The server did not become ready in time"));
      options.onLifecycle?.({ generation: inst.generation, state: "failed", restarted: inst.generation > 1 });
      inst.child.kill();
      scheduleRestart("timed out at startup");
    }, STARTUP_TIMEOUT_MS);

    inst.child.on("spawn", () => {
      // Once stopping, the spawn changes nothing: `shutdown()` kills an unspawned child.
      if (!current() || inst.exited || isStopping()) return;
      inst.spawned = true;
      options.onSpawn?.();
      try {
        // A port posted before the child has spawned is lost, hence here.
        const { port1, port2 } = deps.channel();
        inst.port2 = port2;
        inst.fetch = deps.createFetch(port2);
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a utility process port, not a window
        inst.child.postMessage({ type: "port" }, [port1]);
      } catch (err) {
        // The same failure path as any other startup failure: retire, kill, retry with backoff.
        log.error({ err, generation: inst.generation }, "server process setup failed after spawn");
        retire(inst, err instanceof Error ? err : new Error(String(err)));
        options.onLifecycle?.({ generation: inst.generation, state: "failed", restarted: inst.generation > 1 });
        inst.child.kill();
        scheduleRestart("failed after spawn");
      }
    });
    inst.child.on("message", (message) => {
      // A `ready` from a retired generation, a second one, or one after shutdown began changes nothing:
      // stopping is terminal, and `shutdown()` already settled the ready waiters.
      if (!current() || inst.readySettled || isStopping() || !isMessage(message, "ready")) return;
      clearTimeout(inst.startupTimer);
      inst.readySettled = true;
      state = "running";
      const uptime = numberField(message, "uptimeMs");
      if (uptime !== undefined) options.onUtilityBoot?.(Math.round(uptime));
      options.onReady?.();
      options.onLifecycle?.({ generation: inst.generation, state: "ready", restarted: inst.generation > 1 });
      inst.settleReady.resolve();
    });
    inst.child.on("exit", (code) => {
      inst.exited = true;
      const wasCurrent = current();
      retire(inst, new Error(`The server exited (code ${code})`));
      if (wasCurrent && !isStopping()) {
        log.error({ code, generation: inst.generation }, "server process exited unexpectedly");
        scheduleRestart("exited unexpectedly");
      }
    });
    return inst;
  };

  /**
   * The current instance's readiness, starting one when there is none. Always a promise: a
   * synchronous failure to fork takes the same path as a crash (legal state, one log line, a
   * backoff retry) instead of escaping to the caller as a thrown exception.
   */
  const start = (): Promise<void> => {
    if (isStopping()) return Promise.reject(new Error("The server is shutting down"));
    if (instance) return instance.ready;
    state = "starting";
    try {
      instance = spawn();
    } catch (err) {
      state = "idle";
      log.error({ err }, "server process failed to fork");
      options.onLifecycle?.({ generation: generations, state: "failed", restarted: generations > 1 });
      scheduleRestart("failed to fork");
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return instance.ready;
  };

  const current = async (): Promise<Instance> => {
    await start();
    if (!instance?.fetch || !instance.readySettled) throw new Error("The server is not available");
    return instance;
  };

  void start().catch((err: unknown) => log.error({ err }, "server process failed to start"));

  return {
    get state() {
      return state;
    },
    fetch: async (request) => (await current()).fetch!(request),
    stats: () => {
      const fetch: unknown = instance?.fetch;
      return hasStats(fetch) ? fetch.stats() : undefined;
    },
    ready: async () => {
      await start();
    },
    // Concurrent callers share one stop: each resolves only once the child exited or was killed.
    shutdown: () => (stopping ??= stop()),
  };

  async function stop(): Promise<void> {
    state = "stopping";
    clearTimeout(restartTimer);
    restartTimer = undefined;
    const inst = instance;
    const shuttingDown = new Error("The server is shutting down");
    if (!inst || inst.exited) {
      if (inst) retire(inst, shuttingDown);
      state = "stopped";
      return;
    }
    // Ready waiters learn now that no server is coming; a late `ready` is then ignored.
    if (!inst.readySettled) {
      inst.readySettled = true;
      inst.settleReady.reject(shuttingDown);
    }
    clearTimeout(inst.startupTimer);
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        log.warn({}, "server process did not exit in time, killing it");
        inst.child.kill();
        finish();
      }, SHUTDOWN_GRACE_MS);
      inst.child.on("exit", finish);
      // Before `spawn` the child cannot receive messages; kill it outright.
      if (inst.spawned) {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a utility process port, not a window
        inst.child.postMessage({ type: "shutdown" });
      } else {
        inst.child.kill();
      }
    });
    retire(inst, shuttingDown);
    state = "stopped";
  }
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
}

function numberField(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof field === "number" ? field : undefined;
}

function hasStats(value: unknown): value is { stats(): PortStats } {
  return typeof value === "function" && "stats" in value && typeof value.stats === "function";
}

function isMessage(value: unknown, type: string): boolean {
  return typeof value === "object" && value !== null && "type" in value && value.type === type;
}
