import { useCallback, useEffect, useRef, useState, type PropsWithChildren } from "react";

import { STORAGE_KEYS } from "~/config/storage";
import { visualCookie } from "~/config/visual-cookie";
import { useAppEnvironment } from "~/managers/environment/hooks";
import { visualCodec } from "~/managers/visual/bootstrap";
import { useVisualManager, useVisualState, useVisualStatus } from "~/managers/visual/hooks";
import type { VisualPreferences } from "~/managers/visual/types";

import { readVisualCookie, writeVisualCookie } from "./cookie";
import { VisualCookieContext, type VisualCookieStatus } from "./cookie-context";

export function VisualCookieProvider({
  children,
  requestSeed,
}: PropsWithChildren<{ requestSeed?: VisualPreferences }>) {
  const manager = useVisualManager();
  const { initialized } = useVisualStatus();
  const { preferences } = useVisualState();
  const mirrored = useRef<Readonly<VisualPreferences> | undefined>(undefined);
  const seedAttempted = useRef(false);
  const environment = useAppEnvironment();
  const enabled =
    visualCookie.enabled &&
    !manager.hasExternalColorScheme() &&
    environment.shell.kind === "web" &&
    environment.enhancement === "unavailable";
  const [status, setStatus] = useState<VisualCookieStatus>("pending");
  const sync = useCallback(
    (reset = false) => {
      if (!enabled || !manager.getStatus().initialized) return;
      const current = manager.getSnapshot().preferences;
      mirrored.current = current;
      setStatus(writeVisualCookie(current, document, reset));
    },
    [enabled, manager],
  );

  useEffect(() => {
    if (enabled) return manager.subscribeCommands((command) => sync(command === "reset"));
    return undefined;
  }, [enabled, manager, sync]);

  useEffect(() => {
    if (!enabled || !initialized) return;
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
        if (seed) manager.actions.setPreferences(seed);
      }
    }
    // Commands mirror synchronously. Seeding above can already have replaced this render's preferences.
    if (mirrored.current !== preferences && preferences === manager.getSnapshot().preferences) sync();
  }, [enabled, initialized, manager, preferences, requestSeed, sync]);
  const retry = useCallback(() => sync(false), [sync]);

  return (
    <VisualCookieContext.Provider value={{ status: enabled ? status : "disabled", retry }}>
      {children}
    </VisualCookieContext.Provider>
  );
}
