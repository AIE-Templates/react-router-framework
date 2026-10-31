import type { PropsWithChildren } from "react";

import { VisualManagerProvider } from "./provider";
import type { VisualPreferences } from "./types";
export function VisualManagerRegistry({
  initialState,
  children,
}: PropsWithChildren<{ initialState?: VisualPreferences }>) {
  return <VisualManagerProvider initialPreferences={initialState}>{children}</VisualManagerProvider>;
}
