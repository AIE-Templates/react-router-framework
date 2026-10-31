import { isVisualThemeResult } from "@repo/shared";
import { useEffect, useState, type ReactNode } from "react";

import { useVisualManager } from "~/managers/visual/hooks";
import { useAppEnvironment } from "~/providers/environment";

import { DesktopVisualContext, type DesktopVisualStatus } from "./desktop-visual-context";

/** Electron owns this adapter; Core registries do not know about platform dependencies. */
export function DesktopVisualSync({ children }: { children: ReactNode }) {
  const manager = useVisualManager();
  const environment = useAppEnvironment();
  const [status, setStatus] = useState<DesktopVisualStatus>({ status: "idle" });
  useEffect(() => {
    if (environment.enhancement !== "available" || environment.shell.kind !== "desktop") return undefined;
    const bridge = window.desktop;
    const sync = bridge && "syncVisualTheme" in bridge ? bridge.syncVisualTheme : undefined;
    if (typeof sync !== "function") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Capability feedback belongs to the adapter lifecycle.
      setStatus({ status: "unsupported" });
      return undefined;
    }
    let active = true;
    let sequence = 0;
    let last: string | undefined;
    let failed = false;
    const publish = (retry = false) => {
      if (!manager.getStatus().initialized) return;
      const preference = manager.getSnapshot().preferences.colorScheme;
      if (last === preference && !(retry && failed)) return;
      last = preference;
      failed = false;
      const current = ++sequence;
      setStatus({ status: "pending" });
      void Promise.resolve()
        .then(() => (active && sequence === current ? sync(preference) : undefined))
        .then((input: unknown) => {
          const result = isVisualThemeResult(input)
            ? input
            : { status: "rejected" as const, reason: "invalid-response" };
          if (!active || sequence !== current) return undefined;
          failed =
            result.status === "rejected" ||
            result.persistence === "failed" ||
            result.background === "failed" ||
            result.overlay === "failed";
          setStatus(result);
          return undefined;
        })
        .catch(() => {
          if (!active || sequence !== current) return undefined;
          failed = true;
          setStatus({ status: "rejected", reason: "bridge-unavailable" });
          return undefined;
        });
    };
    publish();
    const releaseState = manager.subscribe(publish);
    const releaseStatus = manager.subscribeStatus(publish);
    const releaseCommands = manager.subscribeCommands(() => publish(true));
    return () => {
      active = false;
      ++sequence;
      releaseState();
      releaseStatus();
      releaseCommands();
    };
  }, [environment.enhancement, environment.shell.kind, manager]);
  return <DesktopVisualContext.Provider value={status}>{children}</DesktopVisualContext.Provider>;
}
