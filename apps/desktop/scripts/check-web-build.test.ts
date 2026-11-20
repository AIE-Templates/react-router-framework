import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkWebBuild, referencedClientAssets } from "./check-web-build.ts";

describe("referenced client assets", () => {
  it("collects quoted hashed asset paths once each and ignores everything else", () => {
    const code = [
      `const manifest={url:"/assets/manifest-70a1eecd.js",entry:{module:"/assets/entry.client-BECgCha7.js",`,
      `imports:['/assets/jsx-runtime-T5ZATrDE.js',"/assets/jsx-runtime-T5ZATrDE.js"]},`,
      `css:[\`/assets/server-build-rGuYU-Fo.css\`],links:"/assets/chat-C_baPD5N.css?v=1"};`,
      // A relative server chunk, an unhashed public file, a bare prefix and a path in a longer URL.
      `import("./assets/server-build-VP5gCnI_.js");const logo="/assets/logo.png",prefix="/assets/";`,
      `const remote="https://cdn.example/assets/remote-ABCDEFGH.js";`,
    ].join("\n");
    expect(referencedClientAssets(code)).toEqual([
      "chat-C_baPD5N.css",
      "entry.client-BECgCha7.js",
      "jsx-runtime-T5ZATrDE.js",
      "manifest-70a1eecd.js",
      "server-build-rGuYU-Fo.css",
    ]);
  });
});

describe("web build check", () => {
  let root: string;
  let desktopDir: string;
  let assets: string;

  beforeEach(() => {
    // The layout the check reads: apps/desktop/.vite/<profile>/utility.mjs and apps/web/build/client/assets.
    root = mkdtempSync(join(tmpdir(), "desktop web build "));
    desktopDir = join(root, "apps", "desktop");
    assets = join(root, "apps", "web", "build", "client", "assets");
    mkdirSync(join(desktopDir, ".vite", "test"), { recursive: true });
    mkdirSync(assets, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const writeUtility = (code: string, profile = "test") => {
    mkdirSync(join(desktopDir, ".vite", profile), { recursive: true });
    writeFileSync(join(desktopDir, ".vite", profile, "utility.mjs"), code);
  };
  const writeAssets = (...files: string[]) => {
    for (const file of files) writeFileSync(join(assets, file), "");
  };

  it("passes when every referenced asset is in the client build, extra client files included", () => {
    writeUtility(`m={module:"/assets/entry.client-BECgCha7.js",css:["/assets/root-CheMk1rO.css"]}`);
    writeAssets("entry.client-BECgCha7.js", "root-CheMk1rO.css", "font-AbCdEfGh.woff2");
    expect(() => checkWebBuild(desktopDir, "test")).not.toThrow();
  });

  it("fails, naming the missing files and the rebuild, when the builds differ", () => {
    writeUtility(`m={module:"/assets/entry.client-BECgCha7.js",css:["/assets/root-CheMk1rO.css"]}`);
    // The client from a later web build: same names, new hashes.
    writeAssets("entry.client-Zz9Yy8Xx.js", "root-CheMk1rO.css");
    expect(() => checkWebBuild(desktopDir, "test")).toThrow(
      /come from different web builds; missing from the client build: entry\.client-BECgCha7\.js\. Run `pnpm build:desktop` first\./,
    );
    // Recovers once the matching client build is back.
    writeAssets("entry.client-BECgCha7.js");
    expect(() => checkWebBuild(desktopDir, "test")).not.toThrow();
  });

  it("checks the named profile's utility bundle", () => {
    writeUtility(`m={module:"/assets/entry.client-BECgCha7.js"}`, "release");
    writeAssets("entry.client-BECgCha7.js");
    expect(() => checkWebBuild(desktopDir, "release")).not.toThrow();
    expect(() => checkWebBuild(desktopDir, "test")).toThrow(/utility\.mjs is missing: run `pnpm build:desktop` first/);
  });

  it("fails when a build is missing or references nothing to compare", () => {
    expect(() => checkWebBuild(desktopDir, "release")).toThrow(
      /\.vite\/release\/utility\.mjs is missing: run `pnpm release:desktop` first/,
    );
    writeUtility("export {};");
    expect(() => checkWebBuild(desktopDir, "test")).toThrow("references no hashed web client assets");
    rmSync(assets, { recursive: true });
    expect(() => checkWebBuild(desktopDir, "test")).toThrow(/assets is missing: run `pnpm build:desktop` first/);
  });

  it("exits 1 with a usage message for a bad command line", () => {
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "check-web-build.ts"), "staging"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown desktop build profile "staging"');
  });
});
