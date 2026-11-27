import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { VISUAL_DEFAULTS, visualRecordKernel, type VisualRecord } from "@repo/shared";
import { compile } from "tailwindcss";
import { expect, it, vi } from "vitest";

import { visualBootstrapConfig, visualCodec, visualScript, visualServerAttributes } from "./bootstrap";
import type { VisualBootstrapRecord } from "./types";

const name = visualBootstrapConfig.cookieName!;
const values = [
  null,
  "invalid",
  ...[1, 2].map((t) =>
    visualRecordKernel.encode({
      version: 1,
      stamp: { t, id: "Z" },
      preferences:
        t === 1 ? { colorScheme: "auto", direction: "rtl" } : { reducedMotion: "full", colorScheme: "light" },
    }),
  ),
];
const preload = (host: Window) => ({ record: host.name || null });

function readReplica(value: string | null | undefined) {
  if (value === undefined) throw new Error("unavailable");
  return value;
}

it.each([
  ["Web SPA", false, false],
  ["Web SSR", true, false],
  ["Electron SPA", false, true],
  ["Electron SSR", true, true],
] as const)("compares serialized and imported prepaint over the %s storage matrix", (_, ssr, desktop) => {
  const config = { ...visualBootstrapConfig, cookieName: ssr ? name : undefined };
  const nativeReader = desktop ? preload : undefined;
  const script = visualScript(nativeReader, config);
  const getLocal = vi.spyOn(Storage.prototype, "getItem");
  const getCookie = vi.spyOn(Document.prototype, "cookie", "get");
  const setLocal = vi.spyOn(Storage.prototype, "setItem");
  const setCookie = vi.spyOn(Document.prototype, "cookie", "set");
  const originalName = window.name;
  const page = document.implementation.createHTMLDocument();
  const webValues = [...values, undefined];
  try {
    for (const local of webValues)
      for (const cookie of ssr ? webValues : [null])
        for (const native of desktop ? values : [null]) {
          getLocal.mockImplementation(() => readReplica(local));
          getCookie.mockImplementation(() => {
            const raw = readReplica(cookie);
            return raw === null ? "" : name + "=" + encodeURIComponent(raw);
          });
          window.name = native ?? "";
          const expected = [native, cookie, local]
            .map((raw) => visualRecordKernel.decode(raw ?? null).record)
            .find(Boolean);
          runInNewContext(script, { window, document: page });
          const result = window.frameworkVisualBootstrap!;
          expect(result).toEqual(visualCodec.read(config, window, nativeReader));
          expect(result.record).toEqual(expected);
          expect(page.documentElement.dataset.colorScheme).toBe(result.state.resolved.colorScheme);
          expect(page.documentElement.dir).toBe(result.state.resolved.direction);
          expect(page.documentElement.dataset.reducedMotion).toBe(
            result.state.resolved.reducedMotion ? "reduce" : "full",
          );
        }
    expect(getCookie.mock.calls.length > 0).toBe(ssr);
    expect(setLocal).not.toHaveBeenCalled();
    expect(setCookie).not.toHaveBeenCalled();
  } finally {
    window.name = originalName;
    delete window.frameworkVisualBootstrap;
    getLocal.mockRestore();
    getCookie.mockRestore();
    setLocal.mockRestore();
    setCookie.mockRestore();
  }
});

it("activates the dark semantic palette and a compiled Tailwind dark utility before hydration", async () => {
  const page = document.implementation.createHTMLDocument();
  const root = page.documentElement;
  const surface = page.createElement("main");
  const utility = "dark:bg-foreground";
  surface.className = utility;
  page.body.append(surface);

  const entry = resolve(import.meta.dirname, "../../styles/index.css");
  const compiler = await compile(readFileSync(entry, "utf8"), {
    base: dirname(entry),
    async loadStylesheet(id, base) {
      const path = createRequire(resolve(base, "index.css")).resolve(
        id === "tailwindcss" ? "tailwindcss/index.css" : id,
      );
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(compiler.build([utility]));
  function stylesIn(layerName: string) {
    return Array.from(sheet.cssRules)
      .filter((rule): rule is CSSLayerBlockRule => rule instanceof CSSLayerBlockRule && rule.name === layerName)
      .flatMap((layer) => Array.from(layer.cssRules))
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule);
  }
  const components = stylesIn("components");
  const dark = components.find((rule) => rule.style.getPropertyValue("color-scheme") === "dark")!;
  const light = components.find((rule) => rule.style.getPropertyValue("color-scheme") === "light")!;
  const variant = stylesIn("utilities").find((rule) => rule.style.backgroundColor === "var(--app-color-foreground)")!;
  expect(root.matches(light.selectorText)).toBe(true);
  expect(root.matches(dark.selectorText)).toBe(false);
  expect(surface.matches(variant.selectorText)).toBe(false);
  for (const token of ["--app-color-background", "--app-color-foreground"]) {
    expect(dark.style.getPropertyValue(token)).toBeTruthy();
    expect(dark.style.getPropertyValue(token)).not.toBe(light.style.getPropertyValue(token));
  }
  const record = visualRecordKernel.encode({
    version: 1,
    stamp: { t: 1, id: "a" },
    preferences: { colorScheme: "dark" },
  });
  const host = { document: page, localStorage: { getItem: () => record } };
  runInNewContext(visualScript(), { window: host, document: page });
  expect(root.dataset.colorScheme).toBe("dark");
  expect(root.matches(dark.selectorText)).toBe(true);
  expect(surface.matches(variant.selectorText)).toBe(true);
});

const fixed = () => ({ record: null, fixedAppearance: "dark" as const });

it.each(["auto", "light", "dark"] as const)(
  "a fixed dark SPA window preserves global %s, RTL and reduced motion",
  (colorScheme) => {
    const preferences = { colorScheme, direction: "rtl", reducedMotion: "reduce" } as const;
    const cookie = vi.fn<() => string>(() => "");
    const document = {
      get cookie() {
        return cookie();
      },
      documentElement: { setAttribute: vi.fn<(name: string, value: string) => void>() },
    };
    const window = {
      document,
      localStorage: { getItem: () => visualRecordKernel.encode({ version: 1, stamp: { t: 2, id: "a" }, preferences }) },
      frameworkVisualBootstrap: undefined as VisualBootstrapRecord | undefined,
    };

    runInNewContext(visualScript(fixed, { ...visualBootstrapConfig, cookieName: undefined }), { window, document });
    expect(cookie).not.toHaveBeenCalled();
    expect(window.frameworkVisualBootstrap?.record?.preferences).toEqual(preferences);
    expect(window.frameworkVisualBootstrap?.state).toEqual({
      preferences,
      resolved: { colorScheme: "dark", direction: "rtl", reducedMotion: true },
    });
  },
);
it("renders explicit server values and integration attributes and leaves auto to CSS", () => {
  const config = { ...visualBootstrapConfig, additionalColorSchemeAttributes: ["data-example-scheme", "onclick"] };
  const record: VisualRecord = {
    version: 1,
    stamp: { t: 1, id: "a" },
    preferences: { colorScheme: "dark", direction: "rtl", reducedMotion: "full" },
  };
  expect(visualServerAttributes(visualCodec.resolve(record), config)).toEqual({
    "data-example-scheme": "dark",
    "data-color-scheme": "dark",
    dir: "rtl",
    "data-reduced-motion": "full",
  });
  expect(visualServerAttributes(visualCodec.resolve(), config)).toEqual({
    dir: VISUAL_DEFAULTS.direction,
    "data-example-scheme": undefined,
    "data-color-scheme": undefined,
    "data-reduced-motion": undefined,
  });
});
