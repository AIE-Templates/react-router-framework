import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { build } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkWebBuild,
  recordWebServerBuild,
  referencedClientAssets,
  WEB_SERVER_RECORD,
  webServerDigest,
} from "./check-web-build.ts";

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

describe("web server build record", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "desktop web server record "));
    mkdirSync(join(directory, "server"));
    writeFileSync(join(directory, "server", "index.js"), `export const answer = 42; // é\n`);
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const bundle = (entrySource: string) => {
    writeFileSync(join(directory, "entry.js"), entrySource);
    return build({
      configFile: false,
      logLevel: "silent",
      plugins: [recordWebServerBuild(join(directory, "server", "index.js"))],
      build: {
        outDir: join(directory, "dist"),
        lib: { entry: join(directory, "entry.js"), formats: ["es"], fileName: () => "utility.mjs" },
      },
    });
  };

  it("records the digest of the server entry the bundle contains", async () => {
    await bundle(`import { answer } from "./server/index.js"; console.log(answer);`);
    expect(JSON.parse(readFileSync(join(directory, "dist", WEB_SERVER_RECORD), "utf8"))).toEqual({
      entry: "apps/web/build/server/index.js",
      sha256: webServerDigest(readFileSync(join(directory, "server", "index.js"), "utf8")),
    });
  });

  it("fails a bundle that does not contain the server entry", async () => {
    await expect(bundle(`console.log(1);`)).rejects.toThrow("the utility bundle does not contain");
  });
});

describe("web build check", () => {
  let root: string;
  let desktopDir: string;
  let assets: string;
  let server: string;

  beforeEach(() => {
    // The layout the check reads: apps/desktop/.vite/<profile>/{utility.mjs,web-server.json} and
    // apps/web/build/{client/assets,server/index.js}.
    root = mkdtempSync(join(tmpdir(), "desktop web build "));
    desktopDir = join(root, "apps", "desktop");
    assets = join(root, "apps", "web", "build", "client", "assets");
    server = join(root, "apps", "web", "build", "server", "index.js");
    mkdirSync(assets, { recursive: true });
    mkdirSync(join(server, ".."), { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A desktop build of `profile` from a web build whose server entry is `serverSource`. */
  const writeBuild = (utility: string, { profile = "test", serverSource = "export const v = 1;\n" } = {}) => {
    const bundles = join(desktopDir, ".vite", profile);
    mkdirSync(bundles, { recursive: true });
    writeFileSync(join(bundles, "utility.mjs"), utility);
    writeFileSync(join(bundles, WEB_SERVER_RECORD), JSON.stringify({ sha256: webServerDigest(serverSource) }));
    writeFileSync(server, serverSource);
  };
  const writeAssets = (...files: string[]) => {
    for (const file of files) writeFileSync(join(assets, file), "");
  };
  const utility = `m={module:"/assets/entry.client-BECgCha7.js",css:["/assets/root-CheMk1rO.css"]}`;

  it("passes when every referenced asset is in the client build, extra client files included", () => {
    writeBuild(utility);
    writeAssets("entry.client-BECgCha7.js", "root-CheMk1rO.css", "font-AbCdEfGh.woff2");
    expect(() => checkWebBuild(desktopDir, "test")).not.toThrow();
  });

  it("fails, naming the missing files and the rebuild, when the client builds differ", () => {
    writeBuild(utility);
    // The client from a later web build: same names, new hashes.
    writeAssets("entry.client-Zz9Yy8Xx.js", "root-CheMk1rO.css");
    expect(() => checkWebBuild(desktopDir, "test")).toThrow(
      /come from different web builds; missing from the client build: entry\.client-BECgCha7\.js\. Run `pnpm build:desktop` first\./,
    );
    // Recovers once the matching client build is back.
    writeAssets("entry.client-BECgCha7.js");
    expect(() => checkWebBuild(desktopDir, "test")).not.toThrow();
  });

  it("fails when only the server build changed, the client hashes being the same", () => {
    writeBuild(utility, { serverSource: "export const v = 1;\n" });
    writeAssets("entry.client-BECgCha7.js", "root-CheMk1rO.css");
    writeFileSync(server, "export const v = 2;\n");
    expect(() => checkWebBuild(desktopDir, "test")).toThrow(
      /utility\.mjs embeds a different web server build than .*index\.js\. Run `pnpm build:desktop` first\./,
    );
    writeFileSync(server, "export const v = 1;\n");
    expect(() => checkWebBuild(desktopDir, "test")).not.toThrow();
  });

  it("checks the named profile's bundles", () => {
    writeBuild(`m={module:"/assets/entry.client-BECgCha7.js"}`, { profile: "release" });
    writeAssets("entry.client-BECgCha7.js");
    expect(() => checkWebBuild(desktopDir, "release")).not.toThrow();
    expect(() => checkWebBuild(desktopDir, "test")).toThrow(/utility\.mjs is missing: run `pnpm build:desktop` first/);
  });

  it("fails when a build is missing or references nothing to compare", () => {
    expect(() => checkWebBuild(desktopDir, "release")).toThrow(
      /\.vite[\\/]release[\\/]utility\.mjs is missing: run `pnpm release:desktop` first/,
    );
    writeBuild("export {};");
    expect(() => checkWebBuild(desktopDir, "test")).toThrow("references no hashed web client assets");
    writeBuild(utility);
    writeAssets("entry.client-BECgCha7.js", "root-CheMk1rO.css");
    rmSync(join(desktopDir, ".vite", "test", WEB_SERVER_RECORD));
    expect(() => checkWebBuild(desktopDir, "test")).toThrow(/web-server\.json is missing: run `pnpm build:desktop`/);
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
