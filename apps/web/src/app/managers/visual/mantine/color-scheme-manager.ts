import type { MantineColorScheme, MantineColorSchemeManager } from "@mantine/core";
import { VISUAL_DEFAULTS, visualRecordKernel } from "@repo/shared";

import type { VisualManager } from "~/managers/visual/manager";
/** Mantine can call set from its own subscription; equal values must not write again. */
export function createMantineColorSchemeManager(
  visual: VisualManager,
  isSchemeForced = false,
): MantineColorSchemeManager {
  let release: (() => void) | undefined;
  let syncSubscriber: ((expected?: MantineColorScheme) => void) | undefined;
  const clientScheme = () => visualRecordKernel.effective(visual.getSnapshot()).colorScheme;
  return {
    // Mantine reads during render, before its subscription takes over from SSR.
    get: () => (release ? clientScheme() : visualRecordKernel.effective(visual.getServerSnapshot()).colorScheme),
    set: (value) => {
      if (value !== clientScheme()) visual.actions.setColorSchemePreference(value);
      // Mantine already adopted the request, but a concurrent Core record can win the commit.
      syncSubscriber?.(value);
    },
    clear: () => {
      visual.actions.resetColorSchemePreference();
      syncSubscriber?.(VISUAL_DEFAULTS.colorScheme);
    },
    subscribe: (notify) => {
      // Mantine ignores notifications in a forced subscription. Releasing the override starts a fresh one.
      if (isSchemeForced) return;
      release?.();
      let previous: MantineColorScheme | undefined;
      syncSubscriber = (expected = previous) => {
        const next = clientScheme();
        if (next !== expected) {
          previous = next;
          notify(next);
        }
      };
      release = visual.subscribe(syncSubscriber);
      // A layout effect or suspended tree can change preferences before this subscription starts.
      syncSubscriber();
    },
    unsubscribe: () => {
      release?.();
      release = undefined;
      syncSubscriber = undefined;
    },
  };
}
