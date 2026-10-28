import { describe, expect, it, vi } from "vitest";

import { resolveRunModes } from "./run-modes.ts";

type Build = "unpackaged" | "test" | "release";

function modes(build: Build, env: Record<string, string>, development = false) {
  return resolveRunModes({
    env,
    development,
    packaged: build !== "unpackaged",
    profile: () => (build === "unpackaged" ? undefined : build),
  });
}

describe("resolveRunModes", () => {
  it.each<[Build, boolean]>([
    ["unpackaged", true],
    ["test", true],
    ["release", false],
  ])("DESKTOP_E2E on a %s build mounts the e2e endpoints: %s", (build, allowed) => {
    const result = modes(build, { DESKTOP_E2E: "1" });
    expect(result.e2e).toBe(allowed);
    expect(result.ignored).toEqual(allowed ? [] : [{ variable: "DESKTOP_E2E", reason: "release profile" }]);
  });

  it.each<[Build, boolean]>([
    ["unpackaged", true],
    ["test", true],
    ["release", false],
  ])("DESKTOP_BENCH on a %s build runs the bench: %s", (build, allowed) => {
    expect(modes(build, { DESKTOP_BENCH: "1" }).bench).toBe(allowed);
  });

  it.each<Build>(["unpackaged", "test", "release"])("DESKTOP_SMOKE runs on a %s build", (build) => {
    expect(modes(build, { DESKTOP_SMOKE: "1" })).toEqual({ bench: false, smoke: true, e2e: false, ignored: [] });
  });

  it("never runs the bench against the dev server", () => {
    expect(modes("unpackaged", { DESKTOP_BENCH: "1" }, true)).toMatchObject({
      bench: false,
      ignored: [{ variable: "DESKTOP_BENCH", reason: "release profile or development" }],
    });
  });

  it("runs at most one: bench, then smoke, then e2e", () => {
    const all = { DESKTOP_BENCH: "1", DESKTOP_SMOKE: "1", DESKTOP_E2E: "1" };
    expect(modes("unpackaged", all)).toEqual({ bench: true, smoke: false, e2e: false, ignored: [] });
    expect(modes("unpackaged", { DESKTOP_SMOKE: "1", DESKTOP_E2E: "1" })).toEqual({
      bench: false,
      smoke: true,
      e2e: false,
      ignored: [],
    });
  });

  it("reads the packaged profile only when a gated variable is set", () => {
    const profile = vi.fn<() => string | undefined>(() => "release");
    resolveRunModes({ env: {}, development: false, packaged: true, profile });
    resolveRunModes({ env: { DESKTOP_SMOKE: "1" }, development: false, packaged: true, profile });
    expect(profile).not.toHaveBeenCalled();
    resolveRunModes({ env: { DESKTOP_BENCH: "1", DESKTOP_E2E: "1" }, development: false, packaged: true, profile });
    expect(profile).toHaveBeenCalledTimes(1);
  });
});
