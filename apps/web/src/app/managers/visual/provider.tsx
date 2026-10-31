import { useEffect, useState, type PropsWithChildren } from "react";

import { VisualManagerContext } from "./context";
import { createVisualManager } from "./manager";
import type { VisualPreferences } from "./types";
export function VisualManagerProvider({
  initialPreferences,
  children,
}: PropsWithChildren<{ initialPreferences?: VisualPreferences }>) {
  const [manager] = useState(() =>
    createVisualManager({ initialPreferences, host: typeof window === "undefined" ? undefined : window }),
  );
  useEffect(() => manager.connect(), [manager]);
  return <VisualManagerContext.Provider value={manager}>{children}</VisualManagerContext.Provider>;
}
