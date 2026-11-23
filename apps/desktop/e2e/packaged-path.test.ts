// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { packagedExecutable } from "./packaged-path.ts";

const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
// A Windows checkout may have CRLF line endings; the assertions below are written for LF.
const readConfig = (name: string) =>
  readFileSync(new URL(`../${name}`, import.meta.url), "utf8").replace(/\r?\n/g, "\n");
const base = readConfig("electron-builder.base.yml");
const leaves = { test: readConfig("electron-builder.test.yml"), release: readConfig("electron-builder.release.yml") };

/** A top-level YAML block list's items, comments left out (the configurations are plain YAML). */
function topLevelList(config: string, key: string): string[] | undefined {
  const lines = config.split(/\r?\n/).filter((line) => !/^\s*#/.test(line));
  const start = lines.indexOf(`${key}:`);
  if (start < 0) return undefined;
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^ {2}- (.+)$/.exec(line);
    if (!item) break;
    items.push(item[1]);
  }
  return items;
}

describe("builder profiles", () => {
  it("leaves everything that differs per profile to the leaf configurations", () => {
    for (const key of ["extends", "files", "extraMetadata", "directories", "afterPack"]) {
      expect(base).not.toMatch(new RegExp(`^${key}:`, "m"));
    }
  });

  it("reads block lists with either line ending", () => {
    expect(topLevelList("files:\r\n  - a\r\n  - b\r\nnext: 1\r\n", "files")).toEqual(["a", "b"]);
  });

  it("starts the test bundles unpackaged", () => {
    expect(metadata.main).toBe(".vite/test/main.cjs");
  });

  it.each(["test", "release"] as const)(
    "packs only the %s bundles, from their own entry, into their own output directory",
    (profile) => {
      const leaf = leaves[profile];
      expect(topLevelList(leaf, "files")).toEqual([
        `".vite/${profile}/main.cjs"`,
        `".vite/${profile}/preload.cjs"`,
        `".vite/${profile}/utility.mjs"`,
        "package.json",
      ]);
      // The bundles know their own profile (DESKTOP_BUILD_PROFILE); the package metadata does not repeat it.
      expect(leaf).not.toContain("desktopProfile");
      expect(leaf).toMatch(
        new RegExp(`^extraMetadata:\\n(?: {2}.*\\n)*? {2}main: \\.vite/${profile}/main\\.cjs$`, "m"),
      );
      expect(leaf).toMatch(new RegExp(`^directories:\\n {2}output: out/${profile}$`, "m"));
      // Both packages get their profile's fuses (scripts/fuses.ts tells which from the entry).
      expect(leaf).toMatch(/^afterPack: \.\/scripts\/fuses\.ts$/m);
    },
  );
});

describe("packaged desktop names", () => {
  it("keeps package metadata and the inherited builder profiles consistent", () => {
    expect(metadata.productName).toBeTypeOf("string");
    expect(base.match(/^productName:\s*(.+)$/m)?.[1]).toBe(metadata.productName);
    for (const leaf of Object.values(leaves)) {
      expect(leaf).toMatch(/^extends: \.\/electron-builder\.base\.yml$/m);
      expect(leaf).not.toMatch(/^\s*productName:/m);
    }
    // The path helper implements default filenames, not platform-specific overrides.
    for (const config of [base, ...Object.values(leaves)]) expect(config).not.toMatch(/^\s*executableName:/m);
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(() => packagedExecutable("out", metadata, platform, "arm64")).not.toThrow();
    }
  });

  it.each([
    ["darwin", "x64", ["mac", "My Product.app", "Contents", "MacOS", "My Product"]],
    ["darwin", "arm64", ["mac-arm64", "My Product.app", "Contents", "MacOS", "My Product"]],
    ["darwin", "universal", ["mac-universal", "My Product.app", "Contents", "MacOS", "My Product"]],
    ["win32", "x64", ["win-unpacked", "My Product.exe"]],
    ["win32", "arm64", ["win-arm64-unpacked", "My Product.exe"]],
    ["linux", "x64", ["linux-unpacked", "desktop-shell"]],
    ["linux", "arm64", ["linux-arm64-unpacked", "desktop-shell"]],
  ] as const)("resolves %s %s using the builder's platform naming", (platform, arch, segments) => {
    expect(packagedExecutable("out", { name: "desktop-shell", productName: "My Product" }, platform, arch)).toBe(
      join("out", ...segments),
    );
  });

  it.each(["Bad/Name", "Bad:Name", "Trailing.", "Trailing ", "CON", "NUL.txt", ""])(
    "rejects product names that would need platform filename sanitization: %j",
    (productName) => {
      expect(() => packagedExecutable("out", { name: "desktop", productName }, "darwin", "arm64")).toThrow(
        "portable desktop filename",
      );
    },
  );
});
