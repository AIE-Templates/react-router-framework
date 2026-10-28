import type { OverlayAppearance } from "@repo/shared";
import { useEffect, useId, type ReactNode } from "react";

import { getInteractiveProps, useWindowChrome } from "../../providers/environment";
import { usePanelEscape, usePanelState } from "../use-panel-state";
import { ShellChromeContext } from "./chrome-context";

export interface BasicShellProps {
  children: ReactNode;
  title?: ReactNode;
  actions?: ReactNode;
  headerMode?: "standalone" | "fused";
  /** One AppShell owns appearance requests; modules never measure DOM and write overlay height. */
  overlayAppearance?: OverlayAppearance;
}

export interface NavigationShellProps extends BasicShellProps {
  navigation: ReactNode;
  navigationLabel?: string;
  navigationOpen?: boolean;
  defaultNavigationOpen?: boolean;
  onNavigationOpenChange?: (open: boolean) => void;
}

export function BasicShell({ children, title, actions, headerMode, overlayAppearance }: BasicShellProps) {
  return (
    <Shell title={title} actions={actions} headerMode={headerMode} overlayAppearance={overlayAppearance}>
      {children}
    </Shell>
  );
}

export function NavigationShell(props: NavigationShellProps) {
  return <Shell {...props} />;
}

function Shell({
  children,
  title,
  actions,
  headerMode = "fused",
  overlayAppearance,
  ...navigationProps
}: BasicShellProps & Partial<NavigationShellProps>) {
  const chrome = useWindowChrome();
  const navigationId = useId();
  const navigation = usePanelState(
    navigationProps.navigationOpen,
    navigationProps.defaultNavigationOpen ?? false,
    navigationProps.onNavigationOpenChange,
    `${navigationId}-trigger`,
  );
  usePanelEscape(navigation.open, navigation.setOpen, navigationId);
  const ready = !chrome.diagnostic || chrome.diagnostic === "host-mismatch";
  const { color, symbolColor, height } = overlayAppearance ?? {};
  const updateAppearance = chrome.updateOverlayAppearance;
  useEffect(() => {
    if (
      chrome.enhancement === "available" &&
      (color !== undefined || symbolColor !== undefined || height !== undefined)
    ) {
      void updateAppearance({ color, symbolColor, height });
    }
  }, [chrome.enhancement, color, symbolColor, height, updateAppearance]);
  return (
    <ShellChromeContext.Provider value={headerMode === "fused" && ready}>
      <div
        className="app-shell"
        data-header-mode={headerMode}
        data-chrome-ready={ready ? "" : undefined}
        data-navigation-open={navigation.open}
        data-navigation-shell={navigationProps.navigation ? "" : undefined}
      >
        {headerMode === "standalone" && (
          <header className="shell-titlebar">
            <div className="shell-titlebar-content" data-window-drag="">
              <strong>{title}</strong>
              <div {...getInteractiveProps()}>{actions}</div>
            </div>
          </header>
        )}
        <div className="shell-body">
          {navigationProps.navigation && (
            <nav id={navigationId} className="shell-nav" aria-label={navigationProps.navigationLabel ?? "Modules"}>
              <div className="shell-nav-chrome" data-window-drag="" aria-hidden="true" />
              <div className="shell-nav-content" {...getInteractiveProps()}>
                <button type="button" className="shell-navigation-toggle" onClick={() => navigation.setOpen(false)}>
                  Close navigation
                </button>
                {navigationProps.navigation}
              </div>
            </nav>
          )}
          {children}
        </div>
        {navigationProps.navigation && (
          <button
            id={`${navigationId}-trigger`}
            type="button"
            className="shell-navigation-toggle shell-navigation-trigger"
            {...getInteractiveProps()}
            aria-expanded={navigation.open}
            aria-controls={navigationId}
            onClick={() => navigation.setOpen(!navigation.open)}
          >
            Modules
          </button>
        )}
      </div>
    </ShellChromeContext.Provider>
  );
}
