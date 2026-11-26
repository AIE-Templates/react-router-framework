import type { VisualRecord, Shell } from "@repo/shared";
import type { PropsWithChildren } from "react";

import type { NativeVisualSource } from "~/managers/visual/types";

import { VisualManagerProvider } from "./provider";

export function VisualManagerRegistry({
  initialState,
  initialShell,
  nativeSource,
  children,
}: PropsWithChildren<{
  initialState?: VisualRecord;
  initialShell?: Shell["kind"];
  nativeSource?: NativeVisualSource;
}>) {
  return (
    <VisualManagerProvider initialRecord={initialState} nativeSource={nativeSource} initialShell={initialShell}>
      {children}
    </VisualManagerProvider>
  );
}
