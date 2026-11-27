import { useContext } from "react";

import { EnvironmentContext } from "./context";

export function useAppEnvironment() {
  const environment = useContext(EnvironmentContext);
  if (!environment) throw new Error("AppRoot is required for application environment access");
  return environment;
}
