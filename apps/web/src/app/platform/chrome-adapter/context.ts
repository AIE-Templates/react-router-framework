import { createContext, useContext } from "react";

import type { ChromeAdapter } from "./runtime";

export const ChromeAdapterContext = createContext<ChromeAdapter | null>(null);

export function useChromeAdapter() {
  const adapter = useContext(ChromeAdapterContext);
  if (!adapter) throw new Error("ChromeAdapterProvider is required for window chrome access");
  return adapter;
}
