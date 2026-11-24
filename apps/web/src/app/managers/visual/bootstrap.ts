/* oxlint-disable unicorn/consistent-function-scoping -- The serialized kernel must have no module-scope dependencies. */
import { STORAGE_KEYS } from "~/config/storage";
import { visualIntegration } from "~/config/visual-integration";

import type {
  ColorSchemeSnapshot,
  VisualBootstrapConfig,
  VisualBootstrapRecord,
  VisualPreferences,
  VisualState,
} from "./types";

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
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.version !== "number") {
        return { kind: "invalid" as const };
      }
      if (value.version !== 1) return { kind: "unsupported-version" as const };
      return { kind: "valid" as const, preferences: parse(value.preferences) };
    } catch {
      return { kind: "invalid" as const };
    }
  }
  function resolve(preferences: VisualPreferences, host?: Window, fixedAppearance?: "light" | "dark"): VisualState {
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
  function read(
    config: VisualBootstrapConfig,
    seed?: VisualPreferences,
    host?: Window,
    externalColorScheme?: ColorSchemeSnapshot,
    fixedAppearance?: "light" | "dark",
  ) {
    let storagePresent: boolean | undefined;
    let preferences = parse(seed);
    let persistence: VisualBootstrapRecord["persistence"] = host ? "ready" : "unavailable";
    if (host) {
      try {
        const raw = host.localStorage.getItem(config.storageKey);
        storagePresent = raw !== null;
        const stored = decode(raw);
        if (stored.kind === "valid") preferences = stored.preferences;
        if (stored.kind === "unsupported-version") persistence = stored.kind;
      } catch {
        persistence = "unavailable";
      }
    }
    return {
      version: 1 as const,
      storageKey: config.storageKey,
      externalColorScheme,
      fixedAppearance,
      state: resolve(
        externalColorScheme ? { ...preferences, colorScheme: externalColorScheme.preference } : preferences,
        host,
        fixedAppearance,
      ),
      persistence,
      storagePresent,
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
  return { parse, decode, resolve, read, apply };
}

export const visualCodec = visualKernel();
/** Serialized alongside the kernel to resolve the document appearance before paint. */
export function webWindowAppearance(host: Window) {
  const fixed = new URLSearchParams(host.location?.search).get("windowAppearance");
  return fixed === "light" || fixed === "dark" ? fixed : undefined;
}

export interface VisualPrepaintSource {
  readFixedAppearance?: (host: Window) => "light" | "dark" | undefined;
  seed?: ColorSchemeSnapshot;
  read: (host: Window, seed?: ColorSchemeSnapshot) => ColorSchemeSnapshot | undefined;
}

export function visualScript(seed?: VisualPreferences, source?: VisualPrepaintSource) {
  const json = (value: unknown) =>
    JSON.stringify(value)
      .replace(/</g, "\\u003c")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  const external = source ? `(${source.read.toString()})(window,${json(source.seed ?? null)})` : "undefined";
  const fixed = `(${(source?.readFixedAppearance ?? webWindowAppearance).toString()})(window)`;
  return `(()=>{const k=(${visualKernel.toString()})();const c=${json(visualBootstrapConfig)};const r=k.read(c,${json(seed ?? null)},window,${external},${fixed});window[c.bootstrapKey]=r;k.apply(c,r.state,document.documentElement)})();`;
}

/** Explicit request seeds must also select integration variables when scripts cannot run. */
export function visualServerAttributes(colorScheme: VisualPreferences["colorScheme"], config = visualBootstrapConfig) {
  if (colorScheme === "auto") return {};
  return Object.fromEntries(
    config.additionalColorSchemeAttributes
      .filter((name) => /^data-[a-z][a-z0-9-]*$/.test(name))
      .map((name) => [name, colorScheme]),
  );
}
