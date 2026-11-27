import type { DesktopBridge } from "@repo/shared";

import type { NativeVisualSource } from "~/managers/visual/types";

/** Serialized verbatim. Only use the immutable document bootstrap here. */
export function desktopVisualPrepaint(host: Window) {
  const bridge: Partial<DesktopBridge> | undefined = host.desktop;
  if (!bridge) return undefined;
  const fixed = bridge.visualSeed?.fixedAppearance;
  return {
    record: bridge.visualSeed?.record ?? null,
    fixedAppearance: fixed === "light" || fixed === "dark" ? fixed : undefined,
  };
}

export const desktopVisualSource: NativeVisualSource = {
  prepaint: desktopVisualPrepaint,
  connect(host) {
    const bridge: Partial<DesktopBridge> | undefined = host.desktop;
    if (typeof bridge?.readVisual !== "function" || typeof bridge.pushVisual !== "function") return undefined;
    return { read: bridge.readVisual, push: bridge.pushVisual };
  },
};
