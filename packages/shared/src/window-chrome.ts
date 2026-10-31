import { type Shell } from "./shell.ts";

/** custom-controls is reserved; the first implementation never resolves to it. */
export type ChromeMode = "native-overlay" | "custom-controls" | "system-decorated";
export interface DesktopBootstrap {
  protocolVersion: 1;
  shell: Extract<Shell, { kind: "desktop" }>;
  mode: ChromeMode;
}
export interface DesktopWindowState {
  revision: number;
  focused: boolean;
  maximized: boolean;
  fullscreen: boolean;
}
/** Height is an Electron titleBarOverlay integer, not a DOM measurement. */
export interface OverlayAppearance {
  color?: string;
  symbolColor?: string;
  height?: number;
}
export interface OverlayAppearanceDeclaration {
  owner: string;
  revision: number;
  appearance: OverlayAppearance | null;
}
export type OverlayAppearanceResult =
  | { status: "applied"; appearance: OverlayAppearance }
  | { status: "unsupported" | "rejected"; reason: string };
export interface WindowChromeBridge {
  readonly platform: string;
  readonly version: string;
  readonly bootstrap: DesktopBootstrap | null;
  subscribeWindowState(this: void, listener: (state: DesktopWindowState) => void): () => void;
  updateOverlayAppearance(this: void, appearance: OverlayAppearance): Promise<OverlayAppearanceResult>;
  declareOverlayAppearance?(this: void, declaration: OverlayAppearanceDeclaration): Promise<OverlayAppearanceResult>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keysWithin(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** A bounded, versioned static payload. Never includes transient window state or credentials. */
export function parseDesktopBootstrap(value: unknown): DesktopBootstrap | null {
  if (!record(value) || !keysWithin(value, ["protocolVersion", "shell", "mode"]) || value.protocolVersion !== 1)
    return null;
  if (value.mode !== "native-overlay" && value.mode !== "system-decorated") return null;
  const shell = value.shell;
  if (!record(shell) || !keysWithin(shell, ["kind", "platform", "osVersion", "desktopEnv", "sessionType"])) return null;
  if (
    shell.kind !== "desktop" ||
    (shell.platform !== "darwin" && shell.platform !== "win32" && shell.platform !== "linux")
  )
    return null;
  if (typeof shell.osVersion !== "string" || shell.osVersion.length > 128) return null;
  const { desktopEnv, sessionType } = shell;
  if (desktopEnv !== undefined && (typeof desktopEnv !== "string" || desktopEnv.length > 128)) return null;
  if (sessionType !== undefined && (typeof sessionType !== "string" || sessionType.length > 128)) return null;
  return Object.freeze({
    protocolVersion: 1,
    mode: value.mode,
    shell: Object.freeze({
      kind: "desktop",
      platform: shell.platform,
      osVersion: shell.osVersion,
      ...(desktopEnv !== undefined ? { desktopEnv } : {}),
      ...(sessionType !== undefined ? { sessionType } : {}),
    }),
  });
}

/** Restrict native appearance to hex colors and a conservative bounded integer height. */
export function parseOverlayAppearance(value: unknown): OverlayAppearance | null {
  if (!record(value) || !keysWithin(value, ["color", "symbolColor", "height"]) || Object.keys(value).length === 0)
    return null;
  const accepted: OverlayAppearance = {};
  for (const field of ["color", "symbolColor"] as const) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== "string" || !/^#[\da-f]{6}([\da-f]{2})?$/i.test(value[field])) return null;
    accepted[field] = value[field];
  }
  if (value.height !== undefined) {
    if (typeof value.height !== "number" || !Number.isInteger(value.height) || value.height < 32 || value.height > 80)
      return null;
    accepted.height = value.height;
  }
  return Object.keys(accepted).length ? accepted : null;
}

export function isDesktopWindowState(value: unknown): value is DesktopWindowState {
  return (
    record(value) &&
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    typeof value.focused === "boolean" &&
    typeof value.maximized === "boolean" &&
    typeof value.fullscreen === "boolean"
  );
}

export function parseOverlayDeclaration(value: unknown): OverlayAppearanceDeclaration | null {
  if (
    !record(value) ||
    !keysWithin(value, ["owner", "revision", "appearance"]) ||
    typeof value.owner !== "string" ||
    !/^[\w:-]{1,128}$/.test(value.owner) ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.revision !== "number" ||
    value.revision < 1
  )
    return null;
  const appearance = value.appearance === null ? null : parseOverlayAppearance(value.appearance);
  if (value.appearance !== null && !appearance) return null;
  return { owner: value.owner, revision: value.revision, appearance };
}
