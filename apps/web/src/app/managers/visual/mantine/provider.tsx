import { DirectionProvider, MantineProvider, useDirection, mergeThemeOverrides } from "@mantine/core";
import { VISUAL_DEFAULTS } from "@repo/shared";
import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore, type PropsWithChildren } from "react";

import { useVisualManager, useVisualState } from "~/managers/visual/hooks";

import { createMantineColorSchemeManager } from "./color-scheme-manager";
import { visualTheme, visualVariables } from "./theme";

// Core's prepaint script and connected manager own both root scheme attributes.
// Mantine's mount effects would otherwise replay the SSR scheme over the prepaint result.
const getMantineRootElement = () => undefined;

const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
function DirectionBridge() {
  const manager = useVisualManager();
  const { setDirection } = useDirection();
  useClientLayoutEffect(() => {
    let previous = manager.getSnapshot().resolved.direction;
    setDirection(previous);
    return manager.subscribe(() => {
      const next = manager.getSnapshot().resolved.direction;
      if (next !== previous) {
        previous = next;
        setDirection(next);
      }
    });
  }, [manager, setDirection]);
  return null;
}
export function VisualMantineProvider({ children, nonce }: PropsWithChildren<{ nonce?: string }>) {
  const manager = useVisualManager();
  // Fixed window appearance is supplied by the client host after the SSR request.
  const fixedAppearance = useSyncExternalStore(
    manager.subscribe,
    () => manager.fixedAppearance,
    () => undefined,
  );
  const isSchemeForced = fixedAppearance !== undefined;
  const colorSchemeManager = useMemo(
    () => createMantineColorSchemeManager(manager, isSchemeForced),
    [manager, isSchemeForced],
  );
  // The first component render matches SSR; DirectionBridge adopts client state before paint.
  const { resolved } = useVisualState();
  const theme = useMemo(() => {
    const transitionProps = { duration: resolved.reducedMotion ? 0 : 150 };
    return mergeThemeOverrides(visualTheme, {
      components: {
        Popover: { defaultProps: { transitionProps } },
        Menu: { defaultProps: { transitionProps } },
        Tooltip: { defaultProps: { transitionProps } },
        Modal: { defaultProps: { transitionProps } },
        // Notifications render only after mount, so following the resolved direction cannot break hydration.
        Notifications: {
          defaultProps: {
            transitionDuration: resolved.reducedMotion ? 0 : 250,
            position: resolved.direction === "rtl" ? "bottom-left" : "bottom-right",
          },
        },
      },
    });
  }, [resolved.reducedMotion, resolved.direction]);
  return (
    <DirectionProvider initialDirection={resolved.direction} detectDirection={false}>
      <MantineProvider
        getRootElement={getMantineRootElement}
        theme={theme}
        cssVariablesResolver={visualVariables}
        colorSchemeManager={colorSchemeManager}
        forceColorScheme={fixedAppearance}
        defaultColorScheme={VISUAL_DEFAULTS.colorScheme}
        getStyleNonce={nonce ? () => nonce : undefined}
      >
        <DirectionBridge />
        {children}
      </MantineProvider>
    </DirectionProvider>
  );
}
