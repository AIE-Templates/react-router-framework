import { describe, expect, it } from "vitest";

import { resolveRunModes } from "./run-modes.ts";

const none = { bench: false, smoke: false, e2e: false, development: false };

describe("resolveRunModes", () => {
  it("runs nothing unless asked", () => {
    expect(resolveRunModes(none)).toEqual({ bench: false, smoke: false, e2e: false, ignored: [] });
  });

  it.each(["bench", "smoke", "e2e"] as const)("runs the %s when it alone is requested", (mode) => {
    expect(resolveRunModes({ ...none, [mode]: true })).toEqual({
      bench: false,
      smoke: false,
      e2e: false,
      [mode]: true,
      ignored: [],
    });
  });

  it("never runs the bench against the dev server, and says so", () => {
    expect(resolveRunModes({ ...none, bench: true, development: true })).toEqual({
      bench: false,
      smoke: false,
      e2e: false,
      ignored: [{ variable: "DESKTOP_BENCH", reason: "development" }],
    });
  });

  it("runs the smoke and mounts the e2e endpoints in development", () => {
    expect(resolveRunModes({ ...none, smoke: true, development: true })).toMatchObject({ smoke: true, ignored: [] });
    expect(resolveRunModes({ ...none, e2e: true, development: true })).toMatchObject({ e2e: true, ignored: [] });
  });

  it("runs at most one: bench, then smoke, then e2e", () => {
    expect(resolveRunModes({ bench: true, smoke: true, e2e: true, development: false })).toEqual({
      bench: true,
      smoke: false,
      e2e: false,
      ignored: [],
    });
    expect(resolveRunModes({ ...none, smoke: true, e2e: true })).toEqual({
      bench: false,
      smoke: true,
      e2e: false,
      ignored: [],
    });
    // The refused bench does not outrank the smoke.
    expect(resolveRunModes({ bench: true, smoke: true, e2e: true, development: true })).toMatchObject({
      bench: false,
      smoke: true,
      e2e: false,
    });
  });
});
