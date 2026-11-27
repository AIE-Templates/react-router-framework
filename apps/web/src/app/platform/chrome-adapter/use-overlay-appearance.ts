import type { OverlayAppearance } from "@repo/shared";
import { useEffect, useId } from "react";

import { useChromeAdapter } from "./context";
import { useChromeState } from "./hooks";

/** Declare a per-window override for this component's lifetime. */
export function useOverlayAppearance(overlayAppearance?: OverlayAppearance) {
  const runtime = useChromeAdapter();
  const { canSetOverlayAppearance } = useChromeState();
  const owner = useId();
  const { color, symbolColor, height } = overlayAppearance ?? {};
  const ownsAppearance =
    canSetOverlayAppearance && (color !== undefined || symbolColor !== undefined || height !== undefined);
  useEffect(() => {
    if (ownsAppearance) void runtime.declareOverlayAppearance(owner, { color, symbolColor, height });
  }, [runtime, owner, ownsAppearance, color, symbolColor, height]);
  useEffect(() => {
    if (!ownsAppearance) return undefined;
    return () => {
      void runtime.declareOverlayAppearance(owner, null);
    };
  }, [runtime, owner, ownsAppearance]);
}
