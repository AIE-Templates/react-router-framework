import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import type { PropsWithChildren } from "react";

import { VisualMantineProvider } from "~/managers/visual/mantine/provider";

import "virtual:visual-fallback.css";
/**
 * This slot is inside body so Mantine style elements remain valid document children.
 * ModalsProvider and the single Notifications host live inside MantineProvider so the imperative
 * `modals.*` and `notifications.*` APIs work anywhere in the app. Their defaults live in the theme.
 */
export function AppUiProvider({ children, nonce }: PropsWithChildren<{ nonce?: string }>) {
  return (
    <VisualMantineProvider nonce={nonce}>
      <ModalsProvider>
        <Notifications />
        {children}
      </ModalsProvider>
    </VisualMantineProvider>
  );
}
