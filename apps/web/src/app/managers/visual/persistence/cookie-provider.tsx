import { useCallback, useEffect, useRef, useState, type PropsWithChildren } from "react";

import { STORAGE_KEYS } from "~/config/storage";
import { visualCookie } from "~/config/visual-cookie";
import { useAppEnvironment } from "~/managers/environment/hooks";
import { visualCodec } from "~/managers/visual/bootstrap";
import { useVisualManager } from "~/managers/visual/hooks";
import type { VisualPreferences } from "~/managers/visual/types";

import { readVisualCookie, writeVisualCookie } from "./cookie";
import { VisualCookieContext, type VisualCookieStatus } from "./cookie-context";

export function VisualCookieProvider({
  children,
  requestSeed,
}: PropsWithChildren<{ requestSeed?: VisualPreferences }>) {
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
      let stored;
      try {
        stored = visualCodec.decode(localStorage.getItem(STORAGE_KEYS.visualPreferences));
      } catch {
        /* A cookie can still seed an in-memory preference. */
      }
      if (!stored || stored.kind === "missing" || stored.kind === "invalid") {
        let seed = requestSeed;
        if (!seed) {
          try {
            const cookie = readVisualCookie(document.cookie);
            if (cookie.kind === "valid") seed = cookie.preferences;
          } catch {
            /* Cookies may be unavailable in this browser. */
          }
        }
        manager.actions.setPreferences(seed ?? manager.getSnapshot().preferences);
      }
    }
    setStatus(writeVisualCookie(manager.getSnapshot().preferences));
  }, [enabled, manager, requestSeed]);
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
