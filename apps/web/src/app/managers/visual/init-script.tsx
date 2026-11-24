import { type VisualPrepaintSource, visualScript } from "./bootstrap";
import { useVisualManager } from "./hooks";
export function VisualInitScript({ nonce, source }: { nonce?: string; source?: VisualPrepaintSource }) {
  const manager = useVisualManager();
  return (
    <script
      nonce={nonce}
      data-visual-init=""
      // SSR and client transforms can format the kernel differently; this script has already run.
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: visualScript(manager.getServerSnapshot().preferences, source) }}
    />
  );
}
