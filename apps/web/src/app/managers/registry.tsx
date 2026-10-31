import type { PropsWithChildren } from "react";

import type { ManagersInitialState } from "./initial-state";
import { VisualManagerRegistry } from "./visual/registry";
export function ManagersRegistry({
  initialState,
  children,
}: PropsWithChildren<{ initialState?: ManagersInitialState }>) {
  return <VisualManagerRegistry initialState={initialState?.visual}>{children}</VisualManagerRegistry>;
}
