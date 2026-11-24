import type { PropsWithChildren } from "react";

import { VisualCookieProvider } from "./persistence/cookie-provider";
import { VisualManagerProvider } from "./provider";
import type { ColorSchemeSnapshot, VisualPreferences } from "./types";
export function VisualManagerRegistry({
  initialState,
  externalColorScheme,
  children,
}: PropsWithChildren<{ initialState?: VisualPreferences; externalColorScheme?: ColorSchemeSnapshot }>) {
  return (
    <VisualManagerProvider initialPreferences={initialState} externalColorScheme={externalColorScheme}>
      <VisualCookieProvider requestSeed={initialState}>{children}</VisualCookieProvider>
    </VisualManagerProvider>
  );
}
