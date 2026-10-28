export {
  DESKTOP_HEADER_PREFIX,
  DESKTOP_HEADERS,
  type DesktopPrefs,
  type DesktopRequest,
  isDesktopHeader,
  parseDesktopHeaders,
} from "./desktop-headers.ts";
export { DESKTOP_PLATFORMS, type DesktopPlatform, type Shell, shellFromEnv, WEB_SHELL } from "./shell.ts";

export {
  type ChromeMode,
  type DesktopBootstrap,
  type DesktopBridge,
  type DesktopWindowState,
  type OverlayAppearance,
  type OverlayAppearanceResult,
  DESKTOP_BOOTSTRAP_ARGUMENT,
  DESKTOP_CHROME_IPC,
  desktopBootstrapFromArguments,
  isDesktopWindowState,
  parseDesktopBootstrap,
  parseOverlayAppearance,
} from "./window-chrome.ts";
export {
  type PreferenceRejection,
  type PreferenceUpdateResult,
  type PreferenceValue,
  applyPreference,
  DESKTOP_PREFS_IPC,
  isPreferenceKey,
  isPreferenceValue,
  PREFERENCE_COOKIE_PREFIX,
  PREFERENCE_LIMITS,
  preferenceCookieValue,
  preferenceCookiesSize,
  preferencesFromCookies,
  preferencesSize,
  sanitizePreferences,
} from "./preferences.ts";
