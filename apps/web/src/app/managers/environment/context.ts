import { createContext, useContext } from "react";

import type { createWindowChromeRuntime } from "./runtime";

export const EnvironmentContext = createContext<ReturnType<typeof createWindowChromeRuntime> | null>(null);

export function useEnvironmentRuntime() {
  const runtime = useContext(EnvironmentContext);
  if (!runtime) throw new Error("AppRoot is required for application environment access");
  return runtime;
}
