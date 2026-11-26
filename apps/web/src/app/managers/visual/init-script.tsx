import { visualScript } from "./bootstrap";
import { useVisualManager } from "./hooks";
import type { NativeVisualSource } from "./types";

export function VisualInitScript({ nonce, prepaint }: { nonce?: string; prepaint?: NativeVisualSource["prepaint"] }) {
  const manager = useVisualManager();
  return (
    <script
      nonce={nonce}
      data-visual-init=""
      // SSR and client transforms can format the kernel differently; this script has already run.
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: visualScript(prepaint ?? manager.prepaint) }}
    />
  );
}
