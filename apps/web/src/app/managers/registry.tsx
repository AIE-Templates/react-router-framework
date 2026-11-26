import type { Shell } from "@repo/shared";
import type { PropsWithChildren } from "react";

import type { ManagersInitialState } from "./initial-state";
import { VisualManagerRegistry } from "./visual/registry";
export function ManagersRegistry({
  initialState,
  initialShell,
  children,
}: PropsWithChildren<{ initialState?: ManagersInitialState; initialShell?: Shell["kind"] }>) {
  return (
    <VisualManagerRegistry initialShell={initialShell} initialState={initialState?.visual}>
      {children}
    </VisualManagerRegistry>
  );
}
