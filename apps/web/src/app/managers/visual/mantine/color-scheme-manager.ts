import type { MantineColorSchemeManager } from "@mantine/core";

import type { VisualManager } from "../manager";
/** Mantine can call set from its own subscription; equal values must not write again. */
export function createMantineColorSchemeManager(visual: VisualManager): MantineColorSchemeManager {
  let release: (() => void) | undefined;
  return {
    get: () => visual.getSnapshot().preferences.colorScheme,
    set: (value) => {
      if (value !== visual.getSnapshot().preferences.colorScheme) visual.actions.setColorSchemePreference(value);
    },
    clear: () => visual.actions.resetColorSchemePreference(),
    subscribe: (notify) => {
      release?.();
      let previous = visual.getSnapshot().preferences.colorScheme;
      release = visual.subscribe(() => {
        const next = visual.getSnapshot().preferences.colorScheme;
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
