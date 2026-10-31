import { createContext, useContext } from "react";
export type VisualCookieStatus = "disabled" | "pending" | "synced" | "failed" | "unsupported-version";
export const VisualCookieContext = createContext<{ status: VisualCookieStatus; retry: () => void }>({
  status: "disabled",
  retry() {},
});
export function useVisualCookieStatus() {
  return useContext(VisualCookieContext);
}
