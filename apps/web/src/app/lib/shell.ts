import type { DesktopRequest, Shell } from "@repo/shared";
import { createContext } from "react-router";

export type { DesktopRequest, Shell };

/**
 * Where the app runs, read with `context.get(shellContext)` in loaders and actions: `{ kind: "web" }`
 * or the desktop shell with its platform. Set by the host from its entry point (`createWebApp({ shell })`,
 * or `WEB_SHELL*` in development), never from the request. Components read useAppEnvironment()
 * from AppRoot; root data seeds hydration and preload confirms runtime identity after mounting.
 */
export const shellContext = createContext<Shell>({ kind: "web" });

/**
 * The desktop shell's per-request facts (title bar mode, full screen, preferences), parsed from its
 * `x-desktop-*` headers, read with `context.get(desktopContext)`. `undefined` outside the desktop
 * shell, whose host removes those headers instead of trusting them.
 */
export const desktopContext = createContext<DesktopRequest | undefined>(undefined);
