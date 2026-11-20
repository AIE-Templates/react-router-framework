import type { AckCoalesceOptions, PortStats } from "@repo/port-fetch";
import type { BrowserWindow, ProcessMetric } from "electron";
import type { Hono } from "hono";

import type { DebugEnv } from "~/debug-env.contract.ts";
import type { BootProfile } from "~/main/boot-profile.ts";
import type { Logger } from "~/main/log.ts";
import type { ServerProcess } from "~/main/server-process.ts";

import type { StreamHelpers } from "./smoke/routes.ts";

// What the two process entries (src/main.ts, src/utility.ts) use of src/diagnostics, and the only
// way they reach it: `~/diagnostics/entry.ts` in dev and test builds, `~/diagnostics/entry.empty.ts`
// in its place in release builds (vite.base.config.ts). Types only, so this file is in no bundle.

/** The test-only runs; at most one is on (src/main/run-modes.ts). */
export interface DiagnosticModes {
  /** The real-app benchmark (`/__bench/*`). */
  bench: boolean;
  /** The in-app smoke (`/__smoke/*`). */
  smoke: boolean;
  /** A Playwright run (`/__e2e/*`). */
  e2e: boolean;
}

/** What a benchmark or smoke run needs of the started app. */
export interface MainRunContext {
  /** The main window, after its first document loaded. */
  window: BrowserWindow;
  log: Logger;
  bootProfile: BootProfile;
  /** Pages come from `react-router dev`, not the utility. */
  development: boolean;
  ackCoalesce: AckCoalesceOptions | false;
  /** The origin the utility (or the dev server) sees. */
  internalOrigin: string;
  /** The utility process, when pages come from it. */
  server: Pick<ServerProcess, "fetch" | "stats"> | undefined;
  getAppMetrics: () => ProcessMetric[];
  /** Shuts the app down and exits with `code`. */
  exit: (code: number) => Promise<void>;
}

export interface MainDiagnosticRun {
  /** What this process runs, and what the utility must be told (`utilityDebugEnv`, ~/debug-env.ts). */
  readonly modes: DiagnosticModes;
  /**
   * Runs the benchmark or the smoke on the loaded main window and exits the app; returns at once
   * when neither is on.
   */
  start(context: MainRunContext): Promise<void>;
}

/**
 * The main process's side: decides which run the debug environment asks for, logging what it
 * refuses. Throws on an invalid benchmark configuration.
 */
export type SelectMainRun = (debug: DebugEnv, options: { development: boolean; log: Logger }) => MainDiagnosticRun;

type Handler = (request: Request) => Response | Promise<Response>;

export interface UtilityDiagnostics {
  /** Mounts the smoke's or the end-to-end tests' endpoints inside the web app's chain; undefined when neither is on. */
  extend: ((app: Hono) => void) | undefined;
  /** Puts the benchmark's endpoints in front of `fetch` when the benchmark is on; `fetch` itself otherwise. */
  wrap(fetch: Handler, serverStats: () => PortStats | undefined): Handler;
}

/** The utility process's side, from the debug environment the main process handed it. */
export type SelectUtilityDiagnostics = (debug: DebugEnv, helpers: StreamHelpers) => UtilityDiagnostics;
