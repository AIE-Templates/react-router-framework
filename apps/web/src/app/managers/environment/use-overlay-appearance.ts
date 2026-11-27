import type { OverlayAppearance } from "@repo/shared";
import { useEffect, useId } from "react";

import { useEnvironmentRuntime } from "./context";
import { useAppEnvironment } from "./hooks";

/** Declare a per-window override for this component's lifetime. */
export function useOverlayAppearance(overlayAppearance?: OverlayAppearance) {
  const runtime = useEnvironmentRuntime();
  const { canSetOverlayAppearance } = useAppEnvironment();
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
