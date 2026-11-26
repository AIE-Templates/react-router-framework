// @vitest-environment node
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { visualRecordKernel } from "@repo/shared";
import { build } from "vite";
import { expect, it } from "vitest";

import { visualCookie } from "~/config/visual-cookie";

import { visualCodec } from "./bootstrap";
import type { VisualBootstrapRecord } from "./types";

it.each([true, false])("runs the minified production prepaint in a fresh realm (SSR=%s)", async (ssr) => {
  const output = await build({
    configFile: false,
    root: fileURLToPath(new URL("../../../../", import.meta.url)),
    logLevel: "silent",
    define: { APP_SSR: JSON.stringify(ssr) },
    resolve: { conditions: ["@repo/source"], tsconfigPaths: true },
    build: {
      write: false,
      minify: true,
      lib: { entry: fileURLToPath(new URL("./bootstrap.ts", import.meta.url)), name: "Visual", formats: ["iife"] },
    },
  });
  const bundle = Array.isArray(output) ? output[0] : output;
  if (!("output" in bundle)) throw new Error("Expected a single production bundle");
  const chunk = bundle.output.find((item) => item.type === "chunk");
  if (!chunk) throw new Error("Missing production prepaint module");
  const script: string = runInNewContext(chunk.code + "\nVisual.visualScript()");
  const local = {
    version: 1,
    stamp: { t: 1, id: "a" },
    preferences: { direction: "rtl", reducedMotion: "reduce" },
  } as const;
  const cookie = { version: 1, stamp: { t: 2, id: "a" }, preferences: { colorScheme: "dark" } } as const;
  const expected = ssr ? cookie : local;
  const attrs: Record<string, string> = {};
  let cookieReads = 0;
  const document = {
    get cookie() {
      cookieReads++;
      return visualCookie.name + "=" + encodeURIComponent(visualRecordKernel.encode(cookie));
    },
    documentElement: {
      setAttribute: (key: string, value: string) => {
        attrs[key] = value;
      },
    },
  };
  const window: {
    document: typeof document;
    localStorage: { getItem: () => string };
    frameworkVisualBootstrap?: VisualBootstrapRecord;
  } = { document, localStorage: { getItem: () => visualRecordKernel.encode(local) } };
  runInNewContext(script, { window, document });
  expect(window.frameworkVisualBootstrap?.record).toEqual(expected);
  expect(window.frameworkVisualBootstrap?.state).toEqual(visualCodec.resolve(expected));
  expect(cookieReads).toBe(ssr ? 1 : 0);
  expect(attrs).toEqual({
    "data-color-scheme": ssr ? "dark" : "light",
    "data-mantine-color-scheme": ssr ? "dark" : "light",
    dir: ssr ? "ltr" : "rtl",
    "data-reduced-motion": ssr ? "full" : "reduce",
  });
});
