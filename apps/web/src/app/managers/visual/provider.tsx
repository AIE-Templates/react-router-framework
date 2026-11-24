import { useEffect, useState, type PropsWithChildren } from "react";

import { VisualManagerContext } from "./context";
import { createVisualManager } from "./manager";
import type { ColorSchemeSnapshot, VisualPreferences } from "./types";
export function VisualManagerProvider({
  initialPreferences,
  externalColorScheme,
  children,
}: PropsWithChildren<{ initialPreferences?: VisualPreferences; externalColorScheme?: ColorSchemeSnapshot }>) {
  const [manager] = useState(() =>
    createVisualManager({
      initialPreferences,
      externalColorScheme,
      host: typeof window === "undefined" ? undefined : window,
    }),
  );
  useEffect(() => manager.connect(), [manager]);
  return <VisualManagerContext.Provider value={manager}>{children}</VisualManagerContext.Provider>;
}
