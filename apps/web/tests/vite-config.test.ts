// @vitest-environment node
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { build, loadConfigFromFile } from "vite";
import { expect, it, vi } from "vitest";

it("builds the static SPA prepaint without reading cookies", async () => {
  const root = resolve(import.meta.dirname, "..");
  const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, undefined, root);
  if (!loaded) throw new Error("Missing web Vite config");
  const { define, resolve: moduleResolution } = loaded.config;
  expect([false, "false"]).toContain(define?.APP_SSR);

  // Build only the prepaint entry with the app's defines and module resolution.
  const result = await build({
    root,
    configFile: false,
    define,
    resolve: moduleResolution,
    logLevel: "silent",
    build: {
      write: false,
      lib: { entry: resolve(root, "src/app/managers/visual/bootstrap.ts"), name: "Visual", formats: ["iife"] },
    },
  });
  const bundle = Array.isArray(result) ? result[0] : result;
  if (!("output" in bundle)) throw new Error("Expected a production bundle");
  const entry = bundle.output.find((item) => item.type === "chunk");
  if (!entry) throw new Error("Missing prepaint entry");
  const script: string = runInNewContext(entry.code + "\nVisual.visualScript()");

  const readCookie = vi.fn<() => string>(() => "");
  const document = {
    get cookie() {
      return readCookie();
    },
    documentElement: { setAttribute: vi.fn<(name: string, value: string) => void>() },
  };
  runInNewContext(script, { document, window: { document, localStorage: { getItem: () => null } } });
  expect(document.documentElement.setAttribute).toHaveBeenCalled();
  expect(readCookie).not.toHaveBeenCalled();
});
