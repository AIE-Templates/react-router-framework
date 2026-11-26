import type { Shell, VisualRecord } from "@repo/shared";
import { useEffect, useState, type PropsWithChildren } from "react";

import { VisualManagerContext } from "./context";
import { createVisualManager } from "./manager";
import type { NativeVisualSource } from "./types";
export function VisualManagerProvider({
  initialRecord,
  initialShell,
  nativeSource,
  children,
}: PropsWithChildren<{
  initialRecord?: VisualRecord;
  initialShell?: Shell["kind"];
  nativeSource?: NativeVisualSource;
}>) {
  const [manager] = useState(() =>
    createVisualManager({
      initialRecord,
      initialShell,
      nativeSource,
      host: typeof window === "undefined" ? undefined : window,
    }),
  );
  useEffect(() => manager.connect(), [manager]);
  return <VisualManagerContext.Provider value={manager}>{children}</VisualManagerContext.Provider>;
}
