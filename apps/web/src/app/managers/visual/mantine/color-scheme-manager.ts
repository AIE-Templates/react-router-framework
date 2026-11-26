import type { MantineColorSchemeManager } from "@mantine/core";
import { visualRecordKernel } from "@repo/shared";

import type { VisualManager } from "~/managers/visual/manager";
/** Mantine can call set from its own subscription; equal values must not write again. */
export function createMantineColorSchemeManager(visual: VisualManager): MantineColorSchemeManager {
  let release: (() => void) | undefined;
  const get = () => visualRecordKernel.effective(visual.getSnapshot()).colorScheme;
  return {
    get,
    set: (value) => {
      if (value !== get()) visual.actions.setColorSchemePreference(value);
    },
    clear: () => visual.actions.resetColorSchemePreference(),
    subscribe: (notify) => {
      release?.();
      let previous = get();
      release = visual.subscribe(() => {
        const next = get();
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
