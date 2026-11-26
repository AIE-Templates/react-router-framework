import { visualScript } from "./bootstrap";
import { useVisualManager } from "./hooks";
export function VisualInitScript({ nonce }: { nonce?: string }) {
  const manager = useVisualManager();
  return (
    <script
      nonce={nonce}
      data-visual-init=""
      // SSR and client transforms can format the kernel differently; this script has already run.
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: visualScript(manager.prepaint) }}
    />
  );
}
