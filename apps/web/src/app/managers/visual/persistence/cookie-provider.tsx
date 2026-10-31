import { useCallback, useEffect, useRef, useState, type PropsWithChildren } from "react";

import { STORAGE_KEYS } from "../../../config/storage";
import { visualCookie } from "../../../config/visual-cookie";
import { useAppEnvironment } from "../../../providers/environment";
import { visualCodec } from "../bootstrap";
import { useVisualManager } from "../hooks";
import { writeVisualCookie } from "./cookie";
import { VisualCookieContext, type VisualCookieStatus } from "./cookie-context";

export function VisualCookieProvider({ children }: PropsWithChildren) {
  const manager = useVisualManager();
  const seedAttempted = useRef(false);
  const environment = useAppEnvironment();
  const enabled = visualCookie.enabled && environment.shell.kind === "web" && environment.enhancement === "unavailable";
  const [status, setStatus] = useState<VisualCookieStatus>("pending");
  const sync = useCallback(() => {
    if (!enabled || !manager.getStatus().initialized) return;
    if (!seedAttempted.current) {
      // Initialization is one attempt, never a write echo for later storage events.
      seedAttempted.current = true;
      try {
        const stored = visualCodec.decode(localStorage.getItem(STORAGE_KEYS.visualPreferences));
        if (stored.kind === "missing" || stored.kind === "invalid") {
          manager.actions.setDirection(manager.getSnapshot().preferences.direction);
        }
      } catch {
        /* A cookie can still mirror an in-memory preference. */
      }
    }
    setStatus(writeVisualCookie(manager.getSnapshot().preferences));
  }, [enabled, manager]);
  useEffect(() => {
    if (!enabled) return () => {};
    // Synchronizing an external cookie reports its actual write result.
    // oxlint-disable-next-line react/set-state-in-effect
    sync();
    const state = manager.subscribe(sync);
    const persistence = manager.subscribeStatus(sync);
    const commands = manager.subscribeCommands((command) => {
      if (command === "reset") setStatus(writeVisualCookie(manager.getSnapshot().preferences, document, true));
      else sync();
    });
    return () => {
      state();
      persistence();
      commands();
    };
  }, [enabled, manager, sync]);
  return (
    <VisualCookieContext.Provider value={{ status: enabled ? status : "disabled", retry: sync }}>
      {children}
    </VisualCookieContext.Provider>
  );
}
