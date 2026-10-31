// Electron host protocol. Core owns only WindowChromeBridge and the environment contract.
import type { PreferenceUpdateResult, PreferenceValue } from "./preferences.ts";
import { DESKTOP_PLATFORMS, type DesktopPlatform, type Shell, WEB_SHELL } from "./shell.ts";
import { parseDesktopBootstrap, type DesktopBootstrap, type WindowChromeBridge } from "./window-chrome.ts";

export interface DesktopBridge extends WindowChromeBridge {
  syncVisualTheme?(this: void, preference: VisualThemePreference): Promise<VisualThemeResult>;
  setPref(this: void, key: string, value: PreferenceValue): Promise<PreferenceUpdateResult>;
  removePref(this: void, key: string): Promise<PreferenceUpdateResult>;
}

export const DESKTOP_BOOTSTRAP_ARGUMENT = "--desktop-bootstrap=";
export const DESKTOP_CHROME_IPC = {
  subscribe: "desktop:chrome:subscribe",
  unsubscribe: "desktop:chrome:unsubscribe",
  state: "desktop:chrome:state",
  appearance: "desktop:chrome:appearance",
  declaration: "desktop:chrome:declaration",
  visualTheme: "desktop:visual:theme",
} as const;

export function desktopBootstrapFromArguments(args: readonly string[]): DesktopBootstrap | null {
  const value = args
    .find((arg) => arg.startsWith(DESKTOP_BOOTSTRAP_ARGUMENT))
    ?.slice(DESKTOP_BOOTSTRAP_ARGUMENT.length);
  if (!value || value.length > 2048) return null;
  try {
    return parseDesktopBootstrap(JSON.parse(value));
  } catch {
    return null;
  }
}

/**
 * The shell described by environment variables, for entries that are started by another process
 * rather than called with options: the desktop dev script starts `react-router dev` with
 * `WEB_SHELL=desktop`, `WEB_SHELL_PLATFORM` (`darwin`, `win32` or `linux`), `WEB_SHELL_OS_VERSION`
 * and optionally `WEB_SHELL_DESKTOP_ENV` and `WEB_SHELL_SESSION_TYPE`. Anything else, an unknown
 * platform included, is the web shell.
 */
export function shellFromEnv(env: Record<string, string | undefined>): Shell {
  const platform = env.WEB_SHELL_PLATFORM;
  if (env.WEB_SHELL !== "desktop" || !isDesktopPlatform(platform)) return WEB_SHELL;
  return {
    kind: "desktop",
    platform,
    osVersion: env.WEB_SHELL_OS_VERSION ?? "",
    ...(env.WEB_SHELL_DESKTOP_ENV ? { desktopEnv: env.WEB_SHELL_DESKTOP_ENV } : {}),
    ...(env.WEB_SHELL_SESSION_TYPE ? { sessionType: env.WEB_SHELL_SESSION_TYPE } : {}),
  };
}

function isDesktopPlatform(value: string | undefined): value is DesktopPlatform {
  return (DESKTOP_PLATFORMS as readonly (string | undefined)[]).includes(value);
}

export type VisualThemePreference = "auto" | "light" | "dark";
export type VisualThemeResult =
  | {
      status: "processed";
      background: "applied" | "failed";
      overlay: "applied" | "failed" | "unsupported";
      persistence: "saved" | "failed";
    }
  | { status: "rejected"; reason: string };
export function isVisualThemePreference(value: unknown): value is VisualThemePreference {
  return value === "auto" || value === "light" || value === "dark";
}
export function isVisualThemeResult(value: unknown): value is VisualThemeResult {
  if (typeof value !== "object" || value === null || !("status" in value)) return false;
  if (value.status === "rejected")
    return "reason" in value && typeof value.reason === "string" && value.reason.length <= 128;
  return (
    value.status === "processed" &&
    "background" in value &&
    ["applied", "failed"].includes(String(value.background)) &&
    "overlay" in value &&
    ["applied", "failed", "unsupported"].includes(String(value.overlay)) &&
    "persistence" in value &&
    ["saved", "failed"].includes(String(value.persistence))
  );
}
