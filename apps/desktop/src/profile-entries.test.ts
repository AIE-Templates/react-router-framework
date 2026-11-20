import { expect, expectTypeOf, it, vi } from "vitest";

import type * as DebugEnvEmpty from "./debug-env.empty.ts";
import type * as DebugEnv from "./debug-env.ts";
import type { MainRunContext } from "./diagnostics/entry.contract.ts";
import type * as DiagnosticsEmpty from "./diagnostics/entry.empty.ts";
import type * as Diagnostics from "./diagnostics/entry.ts";
import type * as DevHostEmpty from "./main/dev-host.empty.ts";
import type * as DevHost from "./main/dev-host.ts";
import type { Logger } from "./main/log.ts";

// The build puts an empty implementation in place of each of these modules in the profiles that must
// not bundle it (PROFILE_ENTRIES in scripts/build-profile.ts). The process entries are typechecked
// against the real module only, so the two must be interchangeable: the same exports, of the same
// declared types.

it("gives every replaced module and its empty implementation the same typed exports", () => {
  expectTypeOf<typeof DebugEnvEmpty>().toEqualTypeOf<typeof DebugEnv>();
  expectTypeOf<typeof DiagnosticsEmpty>().toEqualTypeOf<typeof Diagnostics>();
  expectTypeOf<typeof DevHostEmpty>().toEqualTypeOf<typeof DevHost>();
});

it("gives every replaced module and its empty implementation the same export names at run time", async () => {
  // Only the dev build defines the address, and only it evaluates the real development host.
  vi.stubGlobal("DESKTOP_DEV_SERVER_URL", "http://127.0.0.1:5174");
  try {
    for (const [real, empty] of [
      [await import("./debug-env.ts"), await import("./debug-env.empty.ts")],
      [await import("./diagnostics/entry.ts"), await import("./diagnostics/entry.empty.ts")],
      [await import("./main/dev-host.ts"), await import("./main/dev-host.empty.ts")],
    ]) {
      expect(Object.keys(empty).toSorted()).toEqual(Object.keys(real).toSorted());
    }
  } finally {
    vi.unstubAllGlobals();
  }
});

const appFetch = () => new Response("app");

it("selects nothing and adds nothing in the empty diagnostics", async () => {
  const { selectMainRun, selectUtilityDiagnostics } = await import("./diagnostics/entry.empty.ts");
  const { readDebugEnv } = await import("./debug-env.ts");
  const everything = readDebugEnv({ DESKTOP_BENCH: "1", DESKTOP_SMOKE: "1", DESKTOP_E2E: "1" });
  const log = {
    debug: vi.fn<Logger["debug"]>(),
    info: vi.fn<Logger["info"]>(),
    warn: vi.fn<Logger["warn"]>(),
    error: vi.fn<Logger["error"]>(),
  };
  const run = selectMainRun(everything, { development: true, log });
  expect(run.modes).toEqual({ bench: false, smoke: false, e2e: false });
  // Nothing of the context is used: not the window, not the utility, not the exit.
  const context = new Proxy({}, { get: () => expect.unreachable("the empty run uses nothing") });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a context no member of which may be read
  await run.start(context as MainRunContext);
  expect(log.warn).not.toHaveBeenCalled();

  const utility = selectUtilityDiagnostics(everything, {
    rethrowNonErrors: () => expect.unreachable("the empty diagnostics add no stream"),
    logStreamFailure: () => expect.unreachable("the empty diagnostics add no stream"),
  });
  expect(utility.extend).toBeUndefined();
  expect(utility.wrap(appFetch, () => undefined)).toBe(appFetch);
});
