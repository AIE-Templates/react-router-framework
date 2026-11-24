import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

export function buildMacosAddon(source: string, output: string) {
  execFileSync("xcrun", [
    "clang++",
    "-fobjc-arc",
    "-bundle",
    "-arch",
    "arm64",
    "-arch",
    "x86_64",
    "-mmacosx-version-min=12.0",
    "-framework",
    "AppKit",
    "-undefined",
    "dynamic_lookup",
    "-I",
    resolve(dirname(process.execPath), "../include/node"),
    source,
    "-o",
    output,
  ]);
}
