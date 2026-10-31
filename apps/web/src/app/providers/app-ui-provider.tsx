import type { PropsWithChildren } from "react";
/** UI-specific providers belong inside body, never outside the document. */
export function AppUiProvider({ children }: PropsWithChildren<{ nonce?: string }>) {
  return children;
}
