export { PRODUCT_HEADER_HEIGHT } from "./product-window.ts";
export { APP_ID, cookieSafe, storageKey, cookieName } from "./app-identity.ts";

export { DESKTOP_PLATFORMS, type DesktopPlatform, type Shell, WEB_SHELL } from "./shell.ts";

export {
  type ChromeMode,
  type DesktopBootstrap,
  type WindowChromeBridge,
  type DesktopWindowState,
  type OverlayAppearance,
  type OverlayAppearanceDeclaration,
  parseOverlayDeclaration,
  supportsOverlayAppearance,
  type OverlayAppearanceResult,
  isDesktopWindowState,
  parseDesktopBootstrap,
  parseOverlayAppearance,
} from "./window-chrome.ts";

export {
  DESKTOP_HEADER_PREFIX,
  DESKTOP_HEADERS,
  type DesktopPrefs,
  type DesktopRequest,
  isDesktopHeader,
  parseDesktopHeaders,
} from "./desktop-headers.ts";

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

export {
  type DesktopBridge,
  type VisualMirrorSnapshot,
  DESKTOP_VISUAL_IPC,
  DESKTOP_BOOTSTRAP_ARGUMENT,
  DESKTOP_CHROME_IPC,
  desktopBootstrapFromArguments,
  shellFromEnv,
} from "./desktop-protocol.ts";

export {
  VISUAL_DEFAULTS,
  createVisualRecordKernel,
  visualRecordKernel,
  type VisualPreferences,
  type VisualRecord,
} from "./visual-record.ts";
