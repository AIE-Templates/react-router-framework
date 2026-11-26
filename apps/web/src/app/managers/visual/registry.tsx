import type { VisualRecord, Shell } from "@repo/shared";
import type { PropsWithChildren } from "react";

import { VisualManagerProvider } from "./provider";
export function VisualManagerRegistry({
  initialState,
  initialShell,
  children,
}: PropsWithChildren<{ initialState?: VisualRecord; initialShell?: Shell["kind"] }>) {
  return (
    <VisualManagerProvider initialRecord={initialState} initialShell={initialShell}>
      {children}
    </VisualManagerProvider>
  );
}
