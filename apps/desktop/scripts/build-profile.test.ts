import { describe, expect, it } from "vitest";

import { BUILD_USAGE, buildProfileFrom, bundleDir, isBuildProfile, parseBuildArgs } from "./build-profile.ts";

describe("build profiles", () => {
  it("defaults to release and rejects unknown names", () => {
    expect(buildProfileFrom(undefined)).toBe("release");
    expect(buildProfileFrom("")).toBe("release");
    expect(buildProfileFrom("release")).toBe("release");
    expect(() => buildProfileFrom("production")).toThrow('Unknown desktop build profile "production"');
    expect(isBuildProfile("dev")).toBe(true);
    expect(isBuildProfile("build")).toBe(false);
    expect(isBuildProfile(undefined)).toBe(false);
  });

  it("gives every profile its own bundle directory", () => {
    expect(["dev", "test", "release"].map((profile) => isBuildProfile(profile) && bundleDir(profile))).toEqual([
      ".vite/dev",
      ".vite/test",
      ".vite/release",
    ]);
  });
});

describe("build arguments", () => {
  it.each([
    { args: [], expected: { profile: "release", mode: "desktop" } },
    { args: ["test"], expected: { profile: "test", mode: "desktop" } },
    { args: ["--with-web"], expected: { profile: "release", mode: "with-web" } },
    { args: ["release", "--with-web"], expected: { profile: "release", mode: "with-web" } },
    { args: ["--with-web", "release"], expected: { profile: "release", mode: "with-web" } },
    { args: ["--workspace"], expected: { profile: "release", mode: "workspace" } },
  ])("parses $args", ({ args, expected }) => {
    expect(parseBuildArgs(args)).toEqual(expected);
  });

  it.each([
    { args: ["staging"] },
    // Only scripts/dev.ts builds the dev profile.
    { args: ["dev"] },
    { args: ["dev", "--with-web"] },
    { args: ["test", "release"] },
    { args: ["--with-web", "--workspace"] },
    { args: ["--workspace", "--workspace"] },
    { args: ["test", "--workspace"] },
    { args: ["--workspace", "release"] },
  ])("rejects $args", ({ args }) => {
    expect(() => parseBuildArgs(args)).toThrow(BUILD_USAGE);
  });
});
