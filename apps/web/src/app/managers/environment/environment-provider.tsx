import type { ReactNode } from "react";

import { useChromeSnapshot } from "~/platform/chrome-adapter/hooks";

import { EnvironmentContext } from "./context";

export function EnvironmentProvider({ children }: { children: ReactNode }) {
  const environment = useChromeSnapshot();
  return <EnvironmentContext.Provider value={environment}>{children}</EnvironmentContext.Provider>;
}
