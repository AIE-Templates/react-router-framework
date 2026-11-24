import {
  isVisualThemeResult,
  isVisualThemeSnapshot,
  type DesktopBridge,
  type VisualThemePreference,
} from "@repo/shared";
import { useEffect, useState, type ReactNode } from "react";

import { useAppEnvironment } from "~/managers/environment/hooks";
import { useVisualManager } from "~/managers/visual/hooks";

import { DesktopVisualContext, type DesktopVisualStatus } from "./desktop-visual-context";

const idle: DesktopVisualStatus = { status: "idle" };

export function DesktopVisualSync({ children }: { children: ReactNode }) {
  const manager = useVisualManager();
  const environment = useAppEnvironment();
  const available = environment.enhancement === "available" && environment.shell.kind === "desktop";
  const [status, setStatus] = useState<DesktopVisualStatus>(idle);
  useEffect(() => {
    if (!available) return undefined;
    const bridge = window.desktop as Partial<DesktopBridge> | undefined;
    manager.applyExternalColorScheme({ revision: -1, preference: "auto" });
    if (!bridge || typeof bridge.subscribeVisualTheme !== "function" || typeof bridge.syncVisualTheme !== "function") {
      // oxlint-disable-next-line react-hooks/set-state-in-effect -- Capability status follows the host lifecycle.
      setStatus({ status: "unsupported" });
      return undefined;
    }
    let active = true;
    let sequence = 0;
    const receive = (snapshot: unknown) => {
      if (active && isVisualThemeSnapshot(snapshot)) manager.applyExternalColorScheme(snapshot);
    };
    // Subscribe before sampling; the main process reconciles changes since the preload seed.
    const unsubscribe = bridge.subscribeVisualTheme(receive);
    receive(bridge.visualTheme);
    const sync = bridge.syncVisualTheme;
    const request = async (preference: VisualThemePreference) => {
      const current = ++sequence;
      manager.reportColorSchemeFailure();
      setStatus({ status: "pending" });
      try {
        const input = await sync(preference);
        if (!active || current !== sequence) return;
        const result = isVisualThemeResult(input) ? input : { status: "rejected" as const, reason: "invalid-response" };
        if (result.status === "processed") receive(result.snapshot);
        else manager.reportColorSchemeFailure(preference);
        setStatus(result);
      } catch {
        if (!active || current !== sequence) return;
        manager.reportColorSchemeFailure(preference);
        setStatus({ status: "rejected", reason: "bridge-unavailable" });
      }
    };
    const unbind = manager.bindColorSchemeWriter((preference) => {
      void request(preference);
    });
    return () => {
      active = false;
      unbind();
      unsubscribe();
    };
  }, [available, manager]);
  return <DesktopVisualContext.Provider value={available ? status : idle}>{children}</DesktopVisualContext.Provider>;
}
