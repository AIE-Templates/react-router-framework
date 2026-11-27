/* oxlint-disable unicorn/consistent-function-scoping -- The serialized kernel must have no module-scope dependencies. */
import { createVisualRecordKernel, VISUAL_DEFAULTS, visualRecordKernel, type VisualRecord } from "@repo/shared";

import { STORAGE_KEYS } from "~/config/storage";
import { visualCookie } from "~/config/visual-cookie";
import { visualIntegration } from "~/config/visual-integration";

import { readVisualCookie } from "./cookie";
import type { NativeVisualSource, VisualBootstrapConfig, VisualBootstrapRecord, VisualState } from "./types";

export const visualBootstrapConfig: VisualBootstrapConfig = {
  storageKey: STORAGE_KEYS.visualPreferences,
  bootstrapKey: "frameworkVisualBootstrap",
  cookieName: APP_SSR ? visualCookie.name : undefined,
  ...visualIntegration,
};

export function visualKernel(records: typeof visualRecordKernel, cookieValue: typeof readVisualCookie) {
  function resolve(record?: VisualRecord, host?: Window, fixedAppearance?: "light" | "dark"): VisualState {
    const preferences = records.effective(record);
    function matches(query: string) {
      try {
        return !!host?.matchMedia?.(query).matches;
      } catch {
        return false;
      }
    }
    return {
      preferences: record?.preferences ?? {},
      resolved: {
        colorScheme:
          fixedAppearance ??
          (preferences.colorScheme === "auto"
            ? matches("(prefers-color-scheme: dark)")
              ? "dark"
              : "light"
            : preferences.colorScheme),
        direction: preferences.direction,
        reducedMotion:
          preferences.reducedMotion === "auto"
            ? matches("(prefers-reduced-motion: reduce)")
            : preferences.reducedMotion === "reduce",
      },
    };
  }
  function optional<T>(reader: () => T) {
    try {
      return reader();
    } catch {
      return undefined;
    }
  }
  function read(
    config: VisualBootstrapConfig,
    host: Window,
    native?: NativeVisualSource["prepaint"],
  ): VisualBootstrapRecord {
    const preload = optional(() => native?.(host));
    const name = config.cookieName;
    const record = records.atStart({
      native: records.decode(preload?.record ?? null).record,
      get cookie() {
        return name ? optional(() => records.decode(cookieValue(host.document.cookie, name)).record) : undefined;
      },
      get local() {
        return optional(() => records.decode(host.localStorage.getItem(config.storageKey)).record);
      },
    });
    return {
      storageKey: config.storageKey,
      record,
      fixedAppearance: preload?.fixedAppearance,
      state: resolve(record, host, preload?.fixedAppearance),
    };
  }
  function apply(config: VisualBootstrapConfig, state: VisualState, root: HTMLElement) {
    root.setAttribute("data-color-scheme", state.resolved.colorScheme);
    root.setAttribute("dir", state.resolved.direction);
    root.setAttribute("data-reduced-motion", state.resolved.reducedMotion ? "reduce" : "full");
    for (const attribute of config.additionalColorSchemeAttributes) {
      if (/^data-[a-z][a-z0-9-]*$/.test(attribute)) root.setAttribute(attribute, state.resolved.colorScheme);
    }
  }
  return { resolve, read, apply };
}

export const visualCodec = visualKernel(visualRecordKernel, readVisualCookie);

function inlineJson(value: unknown) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** A platform reader must be a standalone function expression or arrow, with no module dependencies. */
export function visualScript(native?: NativeVisualSource["prepaint"], config = visualBootstrapConfig) {
  const records = `(${createVisualRecordKernel.toString()})(${inlineJson(VISUAL_DEFAULTS)})`;
  return `(()=>{const k=(${visualKernel.toString()})(${records},(${readVisualCookie.toString()}));const c=${inlineJson(config)};const r=k.read(c,window,${native ? `(${native.toString()})` : "undefined"});window[c.bootstrapKey]=r;k.apply(c,r.state,document.documentElement)})();`;
}

/** Leave auto attributes absent for the CSS media-query fallback during SSR. */
export function visualServerAttributes(snapshot: VisualState, config = visualBootstrapConfig) {
  const { colorScheme, direction, reducedMotion } = visualRecordKernel.effective(snapshot);
  const attributes = Object.fromEntries(
    config.additionalColorSchemeAttributes
      .filter((name) => /^data-[a-z][a-z0-9-]*$/.test(name))
      .map((name) => [name, colorScheme === "auto" ? undefined : colorScheme]),
  );
  return {
    ...attributes,
    dir: direction,
    "data-color-scheme": colorScheme === "auto" ? undefined : colorScheme,
    "data-reduced-motion": reducedMotion === "auto" ? undefined : reducedMotion,
  };
}
