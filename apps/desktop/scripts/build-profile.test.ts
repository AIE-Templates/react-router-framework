import { describe, expect, it } from "vitest";

import { BUILD_USAGE, buildProfileFrom, bundleDir, isBuildProfile, parseBuildArgs } from "./build-profile.ts";

describe("build profiles", () => {
  it("defaults to test and rejects unknown names", () => {
    expect(buildProfileFrom(undefined)).toBe("test");
    expect(buildProfileFrom("")).toBe("test");
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
    { args: [], expected: { profile: "test", mode: "desktop" } },
    { args: ["dev"], expected: { profile: "dev", mode: "desktop" } },
    { args: ["--with-web"], expected: { profile: "test", mode: "with-web" } },
    { args: ["release", "--with-web"], expected: { profile: "release", mode: "with-web" } },
    { args: ["--with-web", "release"], expected: { profile: "release", mode: "with-web" } },
    { args: ["--workspace"], expected: { profile: "test", mode: "workspace" } },
  ])("parses $args", ({ args, expected }) => {
    expect(parseBuildArgs(args)).toEqual(expected);
  });

  it.each([
    { args: ["staging"] },
    { args: ["dev", "test"] },
    { args: ["--with-web", "--workspace"] },
    { args: ["--workspace", "--workspace"] },
    { args: ["test", "--workspace"] },
    { args: ["--workspace", "release"] },
  ])("rejects $args", ({ args }) => {
    expect(() => parseBuildArgs(args)).toThrow(BUILD_USAGE);
  });
});
