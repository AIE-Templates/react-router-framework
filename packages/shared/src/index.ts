export { DESKTOP_PLATFORMS, type DesktopPlatform, type Shell, WEB_SHELL } from "./shell.ts";

export {
  type ChromeMode,
  type DesktopBootstrap,
  type WindowChromeBridge,
  type DesktopWindowState,
  type OverlayAppearance,
  type OverlayAppearanceResult,
  isDesktopWindowState,
  parseDesktopBootstrap,
  parseOverlayAppearance,
} from "./window-chrome.ts";
