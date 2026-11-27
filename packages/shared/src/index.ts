export { PRODUCT_HEADER_HEIGHT } from "./product-window.ts";
export { APP_ID, cookieSafe, storageKey, cookieName } from "./app-identity.ts";

export { serializeVisualCookie, visualCookie } from "./visual-cookie.ts";

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
  VISUAL_DEFAULTS,
  createVisualRecordKernel,
  visualRecordKernel,
  type VisualPreferences,
  type VisualRecord,
} from "./visual-record.ts";
