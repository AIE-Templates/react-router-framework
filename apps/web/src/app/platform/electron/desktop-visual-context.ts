import type { VisualThemeResult } from "@repo/shared";
import { createContext, useContext } from "react";
export type DesktopVisualStatus = { status: "idle" | "pending" | "unsupported" } | VisualThemeResult;
export const DesktopVisualContext = createContext<DesktopVisualStatus>({ status: "idle" });
export function useDesktopVisualStatus() {
  return useContext(DesktopVisualContext);
}
