import type { ChromeMode, WindowChromeBridge, Shell } from "@repo/shared";
import { useEffect, useState, type ReactNode } from "react";

import { createWindowChromeRuntime } from "../window-chrome/runtime";
import { EnvironmentContext } from "./environment";

declare global {
  interface Window {
    desktop?: WindowChromeBridge;
  }
}

/** Initial environment seeds hydration only; a confirmed preload identity survives route revalidation. */
export function AppRoot({
  shell,
  mode,
  fullscreen,
  children,
}: {
  shell?: Shell;
  mode?: ChromeMode;
  fullscreen?: boolean;
  children: ReactNode;
}) {
  const [runtime] = useState(() => createWindowChromeRuntime({ shell, mode, fullscreen }));
  useEffect(() => runtime.connect(window.desktop), [runtime]);
  return <EnvironmentContext.Provider value={runtime}>{children}</EnvironmentContext.Provider>;
}
