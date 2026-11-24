import type { VisualThemeSnapshot } from "@repo/shared";

/** Serialized into the nonce/hash-authorized prepaint script; only read preload's immutable document seed. */
export function desktopPrepaintTheme(host: Window, seed?: VisualThemeSnapshot): VisualThemeSnapshot | undefined {
  const bridge = host.desktop;
  if (!bridge || !("visualTheme" in bridge)) return seed;
  const candidate = bridge.visualTheme;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "preference" in candidate &&
    "revision" in candidate &&
    typeof candidate.revision === "number" &&
    Number.isSafeInteger(candidate.revision) &&
    candidate.revision >= 0 &&
    (candidate.preference === "auto" || candidate.preference === "dark" || candidate.preference === "light") &&
    (!seed || candidate.revision >= seed.revision)
  ) {
    return { revision: candidate.revision, preference: candidate.preference };
  }
  return seed ?? { revision: -1, preference: "auto" };
}

export function desktopWindowAppearance(host: Window) {
  const fixed = host.desktop
    ? host.desktop.bootstrap?.fixedAppearance
    : new URL(host.location.href).searchParams.get("windowAppearance");
  return fixed === "light" || fixed === "dark" ? fixed : undefined;
}
