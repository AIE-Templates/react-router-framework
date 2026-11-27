// @vitest-environment node
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { visualRecordKernel, type VisualMirrorSnapshot } from "@repo/shared";
import { build } from "vite";
import { beforeAll, describe, expect, it } from "vitest";

import { visualCookie } from "~/config/visual-cookie";

import { visualCodec } from "./bootstrap";
import type { VisualBootstrapRecord } from "./types";

async function buildScripts(ssr: boolean): Promise<{ web: string; desktop: string }> {
  const output = await build({
    configFile: false,
    root: fileURLToPath(new URL("../../../../", import.meta.url)),
    logLevel: "silent",
    define: { APP_SSR: JSON.stringify(ssr) },
    resolve: { conditions: ["@repo/source"], tsconfigPaths: true },
    build: {
      write: false,
      minify: true,
      lib: {
        entry: fileURLToPath(new URL("../../testing/visual-prepaint.ts", import.meta.url)),
        name: "Visual",
        formats: ["iife"],
      },
    },
  });
  const bundle = Array.isArray(output) ? output[0] : output;
  if (!("output" in bundle)) throw new Error("Expected a single production bundle");
  const chunk = bundle.output.find((item) => item.type === "chunk");
  if (!chunk) throw new Error("Missing production prepaint module");
  return runInNewContext(chunk.code + "\nVisual");
}

function paint(script: string, visualSeed?: VisualMirrorSnapshot) {
  const local = {
    version: 1,
    stamp: { t: 3, id: "a" },
    preferences: { direction: "rtl", reducedMotion: "reduce" },
  } as const;
  const cookie = { version: 1, stamp: { t: 2, id: "a" }, preferences: { colorScheme: "dark" } } as const;
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
    desktop?: { visualSeed: VisualMirrorSnapshot };
    frameworkVisualBootstrap?: VisualBootstrapRecord;
  } = { document, localStorage: { getItem: () => visualRecordKernel.encode(local) } };
  if (visualSeed) window.desktop = { visualSeed };
  runInNewContext(script, { window, document });
  return { handoff: window.frameworkVisualBootstrap, attrs, cookieReads, local, cookie };
}

describe.each([true, false])("minified production prepaint (SSR=%s)", (ssr) => {
  let scripts: Awaited<ReturnType<typeof buildScripts>>;
  beforeAll(async () => {
    scripts = await buildScripts(ssr);
  });

  it("paints the Web record in a fresh realm", () => {
    const { handoff, attrs, cookieReads, local, cookie } = paint(scripts.web);
    const expected = ssr ? cookie : local;
    expect(handoff?.record).toEqual(expected);
    expect(handoff?.state).toEqual(visualCodec.resolve(expected));
    expect(cookieReads).toBe(ssr ? 1 : 0);
    expect(attrs).toEqual({
      "data-color-scheme": ssr ? "dark" : "light",
      dir: ssr ? "ltr" : "rtl",
      "data-reduced-motion": ssr ? "full" : "reduce",
    });
  });

  it("paints the desktop seed with the fixed window appearance in a fresh realm", () => {
    const record = {
      version: 1,
      stamp: { t: 1, id: "desktop" },
      preferences: { colorScheme: "light", direction: "rtl", reducedMotion: "reduce" },
    } as const;
    const { handoff, attrs } = paint(scripts.desktop, {
      record: visualRecordKernel.encode(record),
      pending: false,
      fixedAppearance: "dark",
    });
    expect(handoff?.record).toEqual(record);
    expect(handoff?.fixedAppearance).toBe("dark");
    expect(attrs).toEqual({ "data-color-scheme": "dark", dir: "rtl", "data-reduced-motion": "reduce" });
  });
});
