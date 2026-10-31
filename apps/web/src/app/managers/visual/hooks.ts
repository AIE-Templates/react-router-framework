import { useContext, useSyncExternalStore } from "react";

import { VisualManagerContext } from "./context";
export function useVisualManager() {
  const manager = useContext(VisualManagerContext);
  if (!manager) throw new Error("VisualManagerProvider is required");
  return manager;
}
export function useVisualState() {
  const manager = useVisualManager();
  return useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getServerSnapshot);
}
export function useVisualActions() {
  return useVisualManager().actions;
}
export function useVisualStatus() {
  const manager = useVisualManager();
  return useSyncExternalStore(manager.subscribeStatus, manager.getStatus, manager.getServerStatus);
}
