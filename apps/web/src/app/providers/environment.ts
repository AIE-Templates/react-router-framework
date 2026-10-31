import { createContext, useContext, useSyncExternalStore } from "react";

import { createWindowChromeRuntime } from "../window-chrome/runtime";

export const EnvironmentContext = createContext<ReturnType<typeof createWindowChromeRuntime> | null>(null);

function useRuntime() {
  const runtime = useContext(EnvironmentContext);
  if (!runtime) throw new Error("AppRoot is required for application environment access");
  return runtime;
}

export function useAppEnvironment() {
  const runtime = useRuntime();
  return useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getServerSnapshot);
}

export function useWindowChrome() {
  const runtime = useRuntime();
  const environment = useAppEnvironment();
  return {
    ...environment,
    updateOverlayAppearance: runtime.updateOverlayAppearance,
    declareOverlayAppearance: runtime.declareOverlayAppearance,
  };
}

/** Apply to the actual popup surface, including surfaces portalled outside the shell. */
export function getInteractiveProps(): { "data-window-interactive": string };
export function getInteractiveProps<T extends object>(props: T): T & { "data-window-interactive": string };
export function getInteractiveProps(props?: object) {
  return { ...props, "data-window-interactive": "" };
}

export function getDragRegionProps(): { "data-window-drag": string };
export function getDragRegionProps<T extends object>(props: T): T & { "data-window-drag": string };
export function getDragRegionProps(props?: object) {
  return { ...props, "data-window-drag": "" };
}
