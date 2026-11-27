import type { ChromeMode, WindowChromeBridge, Shell } from "@repo/shared";
import { type ReactNode } from "react";

import { EnvironmentProvider } from "~/managers/environment/environment-provider";
import type { ManagersInitialState } from "~/managers/initial-state";
import { ManagersRegistry } from "~/managers/registry";
import { ChromeAdapterProvider } from "~/platform/chrome-adapter/chrome-adapter-provider";

/** Initial environment seeds hydration only; a confirmed preload identity survives route revalidation. */
export function AppRoot({
  shell,
  mode,
  fullscreen,
  chromeBridge,
  children,
  managersInitialState,
}: {
  shell?: Shell;
  mode?: ChromeMode;
  fullscreen?: boolean;
  chromeBridge?: WindowChromeBridge | null;
  children: ReactNode;
  managersInitialState?: ManagersInitialState;
}) {
  return (
    <ChromeAdapterProvider initial={{ shell, mode, fullscreen }} bridge={chromeBridge}>
      <EnvironmentProvider>
        <ManagersRegistry initialShell={shell?.kind} initialState={managersInitialState}>
          {children}
        </ManagersRegistry>
      </EnvironmentProvider>
    </ChromeAdapterProvider>
  );
}
