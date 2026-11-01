// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { packagedExecutable } from "./packaged-path.ts";

const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const builder = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
const release = readFileSync(new URL("../electron-builder.release.yml", import.meta.url), "utf8");

describe("packaged desktop names", () => {
  it("keeps package metadata and the inherited builder profiles consistent", () => {
    expect(metadata.productName).toBeTypeOf("string");
    expect(builder.match(/^productName:\s*(.+)$/m)?.[1]).toBe(metadata.productName);
    expect(release).toMatch(/^extends: \.\/electron-builder\.yml$/m);
    expect(release).not.toMatch(/^\s*productName:/m);
    // The path helper implements default filenames, not platform-specific overrides.
    for (const config of [builder, release]) expect(config).not.toMatch(/^\s*executableName:/m);
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(() => packagedExecutable("out", metadata, platform, "arm64")).not.toThrow();
    }
  });

  it.each([
    ["darwin", "x64", ["mac", "My Product.app", "Contents", "MacOS", "My Product"]],
    ["darwin", "arm64", ["mac-arm64", "My Product.app", "Contents", "MacOS", "My Product"]],
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
