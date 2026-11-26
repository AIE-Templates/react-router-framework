import type { MantineColorSchemeManager } from "@mantine/core";
import { visualRecordKernel } from "@repo/shared";

import type { VisualManager } from "~/managers/visual/manager";
/** Mantine can call set from its own subscription; equal values must not write again. */
export function createMantineColorSchemeManager(visual: VisualManager): MantineColorSchemeManager {
  let release: (() => void) | undefined;
  const clientScheme = () => visualRecordKernel.effective(visual.getSnapshot()).colorScheme;
  return {
    // Mantine reads during render, before its subscription takes over from SSR.
    get: () => (release ? clientScheme() : visualRecordKernel.effective(visual.getServerSnapshot()).colorScheme),
    set: (value) => {
      if (value !== clientScheme()) visual.actions.setColorSchemePreference(value);
    },
    clear: () => visual.actions.resetColorSchemePreference(),
    subscribe: (notify) => {
      release?.();
      let previous = clientScheme();
      release = visual.subscribe(() => {
        const next = clientScheme();
        if (next !== previous) {
          previous = next;
          notify(next);
        }
      });
      // A layout effect or suspended tree can change preferences before this subscription starts.
      notify(previous);
    },
    unsubscribe: () => {
      release?.();
      release = undefined;
    },
  };
}
