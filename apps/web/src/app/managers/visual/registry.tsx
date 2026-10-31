import type { PropsWithChildren } from "react";

import { VisualCookieProvider } from "./persistence/cookie-provider";
import { VisualManagerProvider } from "./provider";
import type { VisualPreferences } from "./types";
export function VisualManagerRegistry({
  initialState,
  children,
}: PropsWithChildren<{ initialState?: VisualPreferences }>) {
  return (
    <VisualManagerProvider initialPreferences={initialState}>
      <VisualCookieProvider>{children}</VisualCookieProvider>
    </VisualManagerProvider>
  );
}
