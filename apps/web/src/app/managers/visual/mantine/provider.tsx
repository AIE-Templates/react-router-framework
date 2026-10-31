import { DirectionProvider, MantineProvider, useDirection, mergeThemeOverrides } from "@mantine/core";
import { useEffect, useLayoutEffect, useMemo, useState, type PropsWithChildren } from "react";

import { useVisualManager, useVisualState } from "../hooks";
import { createMantineColorSchemeManager } from "./color-scheme-manager";
import { visualTheme, visualVariables } from "./theme";

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
  const [colorSchemeManager] = useState(() => createMantineColorSchemeManager(manager));
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
      },
    });
  }, [resolved.reducedMotion]);
  return (
    <DirectionProvider initialDirection={resolved.direction} detectDirection={false}>
      <MantineProvider
        theme={theme}
        cssVariablesResolver={visualVariables}
        colorSchemeManager={colorSchemeManager}
        defaultColorScheme="auto"
        getStyleNonce={nonce ? () => nonce : undefined}
      >
        <DirectionBridge />
        {children}
      </MantineProvider>
    </DirectionProvider>
  );
}
