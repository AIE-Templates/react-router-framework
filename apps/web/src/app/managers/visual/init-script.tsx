import { visualScript } from "./bootstrap";
import { useVisualManager } from "./hooks";
export function VisualInitScript({ nonce }: { nonce?: string }) {
  const manager = useVisualManager();
  return (
    <script
      nonce={nonce}
      data-visual-init=""
      dangerouslySetInnerHTML={{ __html: visualScript(manager.getServerSnapshot().preferences) }}
    />
  );
}
