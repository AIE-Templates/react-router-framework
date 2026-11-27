import { useSyncExternalStore } from "react";

import { useChromeAdapter } from "./context";

export function useChromeSnapshot() {
  const adapter = useChromeAdapter();
  return useSyncExternalStore(adapter.subscribe, adapter.getSnapshot, adapter.getServerSnapshot);
}

export function useChromeState() {
  return useChromeSnapshot().chrome;
}
