import type { WindowChromeBridge } from "@repo/shared";
import { useEffect, useState, type ReactNode } from "react";

import { ChromeAdapterContext } from "./context";
import { createChromeAdapter, type ChromeSeed } from "./runtime";

declare global {
  interface Window {
    desktop?: WindowChromeBridge;
  }
}

export function ChromeAdapterProvider({
  initial,
  bridge,
  children,
}: {
  initial?: ChromeSeed;
  bridge?: WindowChromeBridge | null;
  children: ReactNode;
}) {
  const [adapter] = useState(() => createChromeAdapter(initial));
  useEffect(() => adapter.connect(bridge === undefined ? window.desktop : (bridge ?? undefined)), [adapter, bridge]);
  return <ChromeAdapterContext.Provider value={adapter}>{children}</ChromeAdapterContext.Provider>;
}
