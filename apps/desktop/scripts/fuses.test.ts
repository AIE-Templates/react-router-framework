import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FuseState, FuseV1Options } from "@electron/fuses";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkPackagedFuses,
  describeFuses,
  FUSE_NAMES,
  type FuseName,
  fuseMismatches,
  fuseReadings,
  FUSES,
  packagedProfileOf,
} from "./fuses.ts";

/** A fuse wire as `getCurrentFuseWire` returns it, from per-fuse states. */
function wireOf(states: Partial<Record<FuseName, number>>): Record<number, number> {
  const wire: Record<number, number> = {};
  for (const name of FUSE_NAMES) {
    const state = states[name];
    if (state !== undefined) wire[FuseV1Options[name]] = state;
  }
  return wire;
}

const onOff = (fuses: Readonly<Record<FuseName, boolean>>) =>
  Object.fromEntries(FUSE_NAMES.map((name) => [name, fuses[name] ? FuseState.ENABLE : FuseState.DISABLE]));

describe("fuse table", () => {
  it("is the plan's table: the test package is release except the Node inspector", () => {
    expect(FUSES.release).toEqual({
      RunAsNode: false,
      EnableCookieEncryption: true,
      EnableNodeOptionsEnvironmentVariable: false,
      EnableNodeCliInspectArguments: false,
      EnableEmbeddedAsarIntegrityValidation: true,
      OnlyLoadAppFromAsar: true,
    });
    expect(FUSES.test).toEqual({ ...FUSES.release, EnableNodeCliInspectArguments: true });
  });

  it("names the fuses in fuse wire order", () => {
    expect(FUSE_NAMES.map((name) => FuseV1Options[name])).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("tells the profile from the package's entry", () => {
    expect(packagedProfileOf(".vite/test/main.cjs")).toBe("test");
    expect(packagedProfileOf(".vite/release/main.cjs")).toBe("release");
    expect(() => packagedProfileOf(".vite/dev/main.cjs")).toThrow("Cannot tell the build profile");
    expect(() => packagedProfileOf(undefined)).toThrow("Cannot tell the build profile");
  });
});

describe("fuse read-back", () => {
  it("accepts a wire that matches the column", () => {
    for (const profile of ["test", "release"] as const) {
      const readings = fuseReadings(wireOf(onOff(FUSES[profile])));
      expect(readings).toEqual(FUSES[profile]);
      expect(fuseMismatches(readings, profile)).toEqual([]);
    }
    expect(describeFuses(fuseReadings(wireOf(onOff(FUSES.test))))).toBe(
      "RunAsNode=false EnableCookieEncryption=true EnableNodeOptionsEnvironmentVariable=false " +
        "EnableNodeCliInspectArguments=true EnableEmbeddedAsarIntegrityValidation=true OnlyLoadAppFromAsar=true",
    );
  });

  it("names every fuse that differs, including removed, unknown and missing ones", () => {
    const readings = fuseReadings(
      wireOf({
        ...onOff(FUSES.release),
        RunAsNode: FuseState.ENABLE,
        EnableCookieEncryption: FuseState.REMOVED,
        OnlyLoadAppFromAsar: FuseState.INHERIT,
        EnableEmbeddedAsarIntegrityValidation: undefined,
      }),
    );
    expect(fuseMismatches(readings, "release")).toEqual([
      "RunAsNode is true, expected false",
      "EnableCookieEncryption is removed, expected true",
      "EnableEmbeddedAsarIntegrityValidation is missing, expected true",
      "OnlyLoadAppFromAsar is unknown, expected true",
    ]);
    // The release package's wire is one mismatch away from the test package's, and back.
    expect(fuseMismatches(fuseReadings(wireOf(onOff(FUSES.release))), "test")).toEqual([
      "EnableNodeCliInspectArguments is false, expected true",
    ]);
    expect(fuseMismatches(fuseReadings(wireOf(onOff(FUSES.test))), "release")).toEqual([
      "EnableNodeCliInspectArguments is true, expected false",
    ]);
  });

  describe("on a binary", () => {
    let directory: string;

    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), "desktop fuses "));
    });

    afterEach(() => rmSync(directory, { recursive: true, force: true }));

    /** A file carrying a fuse wire behind Electron's sentinel, the way the real binary does. */
    function binary(fuses: Readonly<Record<FuseName, boolean>>): string {
      const file = join(directory, "Desktop");
      const wire = FUSE_NAMES.map((name) => (fuses[name] ? FuseState.ENABLE : FuseState.DISABLE));
      writeFileSync(
        file,
        Buffer.concat([
          Buffer.alloc(64, 0),
          Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"),
          Buffer.from([1, wire.length, ...wire]),
          Buffer.alloc(64, 0),
        ]),
      );
      return file;
    }

    it("reads back a fused test binary", async () => {
      await expect(checkPackagedFuses(binary(FUSES.test), "test")).resolves.toEqual(FUSES.test);
    });

    it("rejects a binary whose packaging never flipped its fuses", async () => {
      // Electron's own defaults, as a package whose afterPack did not run keeps them.
      const unflipped = binary({
        RunAsNode: true,
        EnableCookieEncryption: false,
        EnableNodeOptionsEnvironmentVariable: true,
        EnableNodeCliInspectArguments: true,
        EnableEmbeddedAsarIntegrityValidation: false,
        OnlyLoadAppFromAsar: false,
      });
      await expect(checkPackagedFuses(unflipped, "test")).rejects.toThrow(
        "RunAsNode is true, expected false; EnableCookieEncryption is false, expected true; " +
          "EnableNodeOptionsEnvironmentVariable is true, expected false; " +
          "EnableEmbeddedAsarIntegrityValidation is false, expected true; OnlyLoadAppFromAsar is false, expected true",
      );
      await expect(checkPackagedFuses(unflipped, "test")).rejects.toThrow("did the afterPack hook run?");
    });
  });
});
