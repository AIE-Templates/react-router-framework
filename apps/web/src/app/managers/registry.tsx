import type { Shell } from "@repo/shared";
import type { PropsWithChildren } from "react";

import type { NativeVisualSource } from "~/managers/visual/types";

import type { ManagersInitialState } from "./initial-state";
import { VisualManagerRegistry } from "./visual/registry";

export function ManagersRegistry({
  initialState,
  initialShell,
  nativeSource,
  children,
}: PropsWithChildren<{
  initialState?: ManagersInitialState;
  initialShell?: Shell["kind"];
  nativeSource?: NativeVisualSource;
}>) {
  return (
    <VisualManagerRegistry nativeSource={nativeSource} initialShell={initialShell} initialState={initialState?.visual}>
      {children}
    </VisualManagerRegistry>
  );
}
