import { runInNewContext } from "node:vm";

import { VISUAL_DEFAULTS, visualRecordKernel, type VisualRecord } from "@repo/shared";
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

it("executes the inline kernels in isolation for all missing, invalid, equal and ordered replicas", () => {
  const script = visualScript(preload);
  const getLocal = vi.spyOn(Storage.prototype, "getItem");
  const getCookie = vi.spyOn(document, "cookie", "get");
  const setLocal = vi.spyOn(Storage.prototype, "setItem");
  const setCookie = vi.spyOn(Document.prototype, "cookie", "set");
  const originalName = window.name;
  try {
    for (const local of values)
      for (const cookie of values)
        for (const native of values) {
          getLocal.mockReturnValue(local);
          getCookie.mockReturnValue(cookie === null ? "" : name + "=" + encodeURIComponent(cookie));
          window.name = native ?? "";
          const expected = visualRecordKernel.pick(
            [local, cookie, native].map((raw) => visualRecordKernel.decode(raw).record),
          );
          runInNewContext(script, { window, document });
          const result = window.frameworkVisualBootstrap!;
          expect(result).toEqual(visualCodec.read(visualBootstrapConfig, window, preload));
          expect(result.record).toEqual(expected);
          expect(document.documentElement.dataset.colorScheme).toBe(result.state.resolved.colorScheme);
          expect(document.documentElement.dir).toBe(result.state.resolved.direction);
          expect(document.documentElement.dataset.reducedMotion).toBe(
            result.state.resolved.reducedMotion ? "reduce" : "full",
          );
        }
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

const fixed = () => ({ record: null, fixedAppearance: "dark" as const });

it("skips cookies in SPA prepaint and keeps a platform-fixed scheme out of the record", () => {
  const cookie = vi.fn<() => string>(() => "");
  const document = {
    get cookie() {
      return cookie();
    },
    documentElement: { setAttribute: vi.fn<(name: string, value: string) => void>() },
  };
  const window = {
    document,
    localStorage: { getItem: () => values[3] },
    frameworkVisualBootstrap: undefined as VisualBootstrapRecord | undefined,
  };

  runInNewContext(visualScript(fixed, { ...visualBootstrapConfig, cookieName: undefined }), { window, document });
  expect(cookie).not.toHaveBeenCalled();
  expect(window.frameworkVisualBootstrap?.state).toMatchObject({
    preferences: { colorScheme: "light" },
    resolved: { colorScheme: "dark" },
  });
});
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
