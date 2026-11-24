import { useSyncExternalStore } from "react";

import { useEnvironmentRuntime } from "./context";

export function useAppEnvironment() {
  const runtime = useEnvironmentRuntime();
  return useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getServerSnapshot);
}
