import type { PropsWithChildren } from "react";

import { VisualMantineProvider } from "../managers/visual/mantine/provider";

import "virtual:visual-fallback.css";
/** This slot is inside body so Mantine style elements remain valid document children. */
export function AppUiProvider({ children, nonce }: PropsWithChildren<{ nonce?: string }>) {
  return <VisualMantineProvider nonce={nonce}>{children}</VisualMantineProvider>;
}
