import type { DesktopBridge, DesktopRequest, Shell } from "@repo/shared";
import { useEffect, useState, type ReactNode } from "react";

import { createWindowChromeRuntime } from "../window-chrome/runtime";
import { EnvironmentContext } from "./environment";

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

/** Root data seeds hydration only; a confirmed preload identity survives route revalidation. */
export function AppRoot({
  shell,
  desktop,
  children,
}: {
  shell?: Shell;
  desktop?: DesktopRequest;
  children: ReactNode;
}) {
  const [runtime] = useState(() => createWindowChromeRuntime({ shell, desktop }));
  useEffect(() => runtime.connect(window.desktop), [runtime]);
  return <EnvironmentContext.Provider value={runtime}>{children}</EnvironmentContext.Provider>;
}
