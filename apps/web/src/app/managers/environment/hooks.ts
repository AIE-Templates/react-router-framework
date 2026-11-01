import { useContext, useSyncExternalStore } from "react";

import { EnvironmentContext } from "./context";

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
