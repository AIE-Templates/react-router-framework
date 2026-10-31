import type { ChromeMode, VisualThemePreference, OverlayAppearance } from "@repo/shared";

export interface ChromePolicy {
  platform: string;
  requestedMode: ChromeMode;
  resolvedMode: Exclude<ChromeMode, "custom-controls">;
  fallbackReason?: string;
  appearance: OverlayAppearance;
  backgroundColor: string;
  followsSystemTheme: boolean;
  themePreference: VisualThemePreference;
}

export function chromeAppearance(dark: boolean): OverlayAppearance & { color: string } {
  return { color: dark ? "#17191d" : "#ffffff", symbolColor: dark ? "#f3f4f6" : "#202124", height: 36 };
}

/** Supported desktop platforms use native overlay unless system decoration is requested. */
export function resolveChromePolicy({
  platform,
  requestedMode = "native-overlay",
  themePreference = "auto",
  darkColors = false,
}: {
  platform: string;
  requestedMode?: ChromeMode;
  themePreference?: VisualThemePreference;
  darkColors?: boolean;
}): ChromePolicy {
  const dark = themePreference === "dark" || (themePreference !== "light" && darkColors);
  const appearance = { ...chromeAppearance(dark), height: platform === "win32" ? 48 : 36 };
  const base = {
    platform,
    requestedMode,
    themePreference,
    appearance,
    backgroundColor: appearance.color,
    followsSystemTheme: themePreference !== "light" && themePreference !== "dark",
  };
  if (requestedMode === "system-decorated") return { ...base, resolvedMode: "system-decorated" };
  if (requestedMode === "custom-controls")
    return { ...base, resolvedMode: "system-decorated", fallbackReason: "custom-controls-not-implemented" };
  if (!["darwin", "win32", "linux"].includes(platform))
    return { ...base, resolvedMode: "system-decorated", fallbackReason: "unsupported-platform" };
  return { ...base, resolvedMode: "native-overlay" };
}

export function chromeWindowOptions(policy: ChromePolicy): {
  backgroundColor: string;
  titleBarStyle?: "hidden";
  titleBarOverlay?: boolean | OverlayAppearance;
} {
  if (policy.resolvedMode !== "native-overlay") return { backgroundColor: policy.backgroundColor };
  return {
    backgroundColor: policy.backgroundColor,
    titleBarStyle: "hidden",
    // Electron 45's WindowButtonsProxy centers the actual AppKit button frames in this height.
    // Keep native margins: trafficLightPosition supplies a y margin that can disable that centering.
    // https://github.com/electron/electron/blob/v45.0.0/shell/browser/ui/cocoa/window_buttons_proxy.mm
    titleBarOverlay: policy.platform === "darwin" ? { height: 48 } : policy.appearance,
  };
}
