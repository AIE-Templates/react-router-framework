/* oxlint-disable unicorn/consistent-function-scoping -- The serialized kernel must have no module-scope dependencies. */
import { STORAGE_KEYS } from "../../config/storage";
import { visualIntegration } from "../../config/visual-integration";
import type { VisualBootstrapConfig, VisualBootstrapRecord, VisualPreferences, VisualState } from "./types";

export const visualBootstrapConfig: VisualBootstrapConfig = {
  storageKey: STORAGE_KEYS.visualPreferences,
  bootstrapKey: "frameworkVisualBootstrap",
  ...visualIntegration,
};

/** Self-contained by design: the same parser executes in the prepaint script and runtime. */
export function visualKernel() {
  function parse(value: unknown): VisualPreferences {
    const v = value && typeof value === "object" ? (value as Partial<VisualPreferences>) : {};
    return {
      colorScheme: v.colorScheme === "dark" || v.colorScheme === "light" ? v.colorScheme : "auto",
      direction: v.direction === "rtl" ? "rtl" : "ltr",
      reducedMotion: v.reducedMotion === "reduce" || v.reducedMotion === "full" ? v.reducedMotion : "auto",
    };
  }
  function decode(raw: string | null) {
    if (raw === null) return { kind: "missing" as const };
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object") return { kind: "invalid" as const };
      if (value.version !== 1) return { kind: "unsupported-version" as const };
      return { kind: "valid" as const, preferences: parse(value.preferences) };
    } catch {
      return { kind: "invalid" as const };
    }
  }
  function resolve(preferences: VisualPreferences, host?: Window): VisualState {
    const matches = (query: string) => {
      try {
        return !!host?.matchMedia?.(query).matches;
      } catch {
        return false;
      }
    };
    return {
      preferences,
      resolved: {
        colorScheme:
          preferences.colorScheme === "auto"
            ? matches("(prefers-color-scheme: dark)")
              ? "dark"
              : "light"
            : preferences.colorScheme,
        direction: preferences.direction,
        reducedMotion:
          preferences.reducedMotion === "auto"
            ? matches("(prefers-reduced-motion: reduce)")
            : preferences.reducedMotion === "reduce",
      },
    };
  }
  function read(config: VisualBootstrapConfig, seed?: VisualPreferences, host?: Window): VisualBootstrapRecord {
    let preferences = parse(seed);
    let persistence: VisualBootstrapRecord["persistence"] = host ? "ready" : "unavailable";
    if (host) {
      try {
        const stored = decode(host.localStorage.getItem(config.storageKey));
        if (stored.kind === "valid") preferences = stored.preferences;
        if (stored.kind === "unsupported-version") persistence = stored.kind;
      } catch {
        persistence = "unavailable";
      }
    }
    return { version: 1, storageKey: config.storageKey, state: resolve(preferences, host), persistence };
  }
  function apply(config: VisualBootstrapConfig, state: VisualState, root: HTMLElement) {
    root.setAttribute("data-color-scheme", state.resolved.colorScheme);
    root.setAttribute("dir", state.resolved.direction);
    root.setAttribute("data-reduced-motion", state.resolved.reducedMotion ? "reduce" : "full");
    for (const attribute of config.additionalColorSchemeAttributes) {
      if (/^data-[a-z][a-z0-9-]*$/.test(attribute)) root.setAttribute(attribute, state.resolved.colorScheme);
    }
  }
  return { parse, decode, resolve, read, apply };
}

export const visualCodec = visualKernel();
export function visualScript(seed?: VisualPreferences) {
  const json = (value: unknown) =>
    JSON.stringify(value)
      .replace(/</g, "\\u003c")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  return `(()=>{const k=(${visualKernel.toString()})();const c=${json(visualBootstrapConfig)};const r=k.read(c,${json(seed ?? null)},window);window[c.bootstrapKey]=r;k.apply(c,r.state,document.documentElement)})();`;
}
