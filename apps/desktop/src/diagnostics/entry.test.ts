import { createServerApp, logger, logStreamFailure, rethrowNonErrors } from "@repo/server";
import { describe, expect, it, vi } from "vitest";

import { readDebugEnv } from "~/debug-env.ts";

import type { MainRunContext } from "./entry.contract.ts";
import { selectMainRun, selectUtilityDiagnostics } from "./entry.ts";

const origin = "http://app.desktop";
const quietLog = () => ({
  debug: vi.fn<(data: Record<string, unknown>, msg: string) => void>(),
  info: vi.fn<(data: Record<string, unknown>, msg: string) => void>(),
  warn: vi.fn<(data: Record<string, unknown>, msg: string) => void>(),
  error: vi.fn<(data: Record<string, unknown>, msg: string) => void>(),
});

describe("selectMainRun", () => {
  it("selects at most one run from the debug environment", () => {
    const log = quietLog();
    const select = (env: Record<string, string>) => selectMainRun(readDebugEnv(env), { development: false, log }).modes;
    expect(select({})).toEqual({ bench: false, smoke: false, e2e: false });
    expect(select({ DESKTOP_E2E: "1" })).toEqual({ bench: false, smoke: false, e2e: true });
    expect(select({ DESKTOP_SMOKE: "1", DESKTOP_E2E: "1" })).toEqual({ bench: false, smoke: true, e2e: false });
    expect(select({ DESKTOP_BENCH: "1", DESKTOP_SMOKE: "1" })).toEqual({ bench: true, smoke: false, e2e: false });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("refuses the benchmark in development and says so", () => {
    const log = quietLog();
    const run = selectMainRun(readDebugEnv({ DESKTOP_BENCH: "1" }), { development: true, log });
    expect(run.modes.bench).toBe(false);
    expect(log.warn).toHaveBeenCalledExactlyOnceWith({ reason: "development" }, "DESKTOP_BENCH ignored");
  });

  it("rejects an invalid benchmark configuration when selecting, and only for a benchmark run", () => {
    const log = quietLog();
    const env = { DESKTOP_BENCH_CASES: "nope" };
    expect(() => selectMainRun(readDebugEnv(env), { development: false, log })).not.toThrow();
    expect(() => selectMainRun(readDebugEnv({ ...env, DESKTOP_BENCH: "1" }), { development: false, log })).toThrow(
      /Unknown bench case/,
    );
  });

  it("starts nothing when no benchmark or smoke was selected", async () => {
    const log = quietLog();
    for (const env of [{}, { DESKTOP_E2E: "1" }]) {
      const run = selectMainRun(readDebugEnv(env), { development: false, log });
      // Nothing of the context is used: not the window, not the utility, not the exit.
      const context = new Proxy({}, { get: () => expect.unreachable("no run uses the context") });
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a context no member of which may be read
      await run.start(context as MainRunContext);
    }
  });
});

describe("selectUtilityDiagnostics", () => {
  const helpers = { rethrowNonErrors, logStreamFailure };
  /** The statuses of one endpoint per diagnostic, mounted the way the utility entry mounts them. */
  async function statuses(env: Record<string, string>) {
    const diagnostics = selectUtilityDiagnostics(readDebugEnv(env), helpers);
    const app = createServerApp({ logger: logger.child({}, { level: "silent" }) });
    diagnostics.extend?.(app);
    const handler = diagnostics.wrap(
      (request) => app.fetch(request),
      () => undefined,
    );
    const status = async (path: string) => (await handler(new Request(origin + path))).status;
    return {
      extended: diagnostics.extend !== undefined,
      // Both answer 404 for an unknown stream or a missing route; only a mounted route answers JSON.
      smoke: await (await handler(new Request(`${origin}/__smoke/sse-status?id=unknown`))).text(),
      e2e: await status("/__e2e/cookies"),
      bench: await status("/__bench/proc"),
    };
  }

  it("adds no endpoint unless the main process asks for one", async () => {
    const none = await statuses({});
    expect(none).toMatchObject({ extended: false, e2e: 404, bench: 404 });
    // The same answer as any other unknown path.
    const app = createServerApp({ logger: logger.child({}, { level: "silent" }) });
    expect(none.smoke).toBe(await (await app.fetch(new Request(`${origin}/__smoke/sse-status?id=unknown`))).text());
  });

  it("adds only the endpoints of the run the main process selected", async () => {
    const none = await statuses({});
    const smoke = await statuses({ DESKTOP_SMOKE: "1" });
    expect(smoke).toMatchObject({ extended: true, e2e: 404, bench: 404 });
    expect(smoke.smoke).not.toBe(none.smoke);

    const e2e = await statuses({ DESKTOP_E2E: "1" });
    expect(e2e).toMatchObject({ extended: true, smoke: none.smoke, bench: 404 });
    expect(e2e.e2e).not.toBe(404);

    const bench = await statuses({ DESKTOP_BENCH: "1" });
    expect(bench).toMatchObject({ extended: false, smoke: none.smoke, e2e: 404, bench: 200 });
  });
});
