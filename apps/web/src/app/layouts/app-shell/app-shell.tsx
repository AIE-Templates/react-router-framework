import type { OverlayAppearance } from "@repo/shared";
import { useId, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";

import { usePanelEscape, usePanelState } from "~/layouts/use-panel-state";
import { getDragRegionProps, getInteractiveProps } from "~/platform/chrome-adapter/dom-props";
import { useChromeState } from "~/platform/chrome-adapter/hooks";
import { useOverlayAppearance } from "~/platform/chrome-adapter/use-overlay-appearance";

import { ShellChromeContext } from "./chrome-context";

export interface BasicShellProps {
  children: ReactNode;
  title?: ReactNode;
  /** Minimum height for this layout’s headers in CSS pixels. */
  headerMinHeight?: number;
  actions?: ReactNode;
  headerMode?: "standalone" | "fused";
  /** The app shell owns native overlay appearance requests for every app area. */
  overlayAppearance?: OverlayAppearance;
}

export interface NavigationShellProps extends BasicShellProps {
  navigation: ReactNode;
  navigationLabel?: string;
  navigationOpen?: boolean;
  defaultNavigationOpen?: boolean;
  onNavigationOpenChange?: (open: boolean) => void;
}

export function BasicShell(props: BasicShellProps) {
  return <Shell {...props} />;
}

export function NavigationShell(props: NavigationShellProps) {
  return <Shell {...props} />;
}

function Shell({
  children,
  title,
  actions,
  headerMinHeight,
  headerMode = "fused",
  overlayAppearance,
  ...navigationProps
}: BasicShellProps & Partial<NavigationShellProps>) {
  const chrome = useChromeState();
  useOverlayAppearance(overlayAppearance);
  const body = useRef<HTMLDivElement>(null);
  const navigationId = useId();
  const navigation = usePanelState(
    navigationProps.navigationOpen,
    navigationProps.defaultNavigationOpen ?? false,
    navigationProps.onNavigationOpenChange,
    `${navigationId}-trigger`,
  );
  usePanelEscape(navigation.open, navigation.setOpen, navigationId);
  useLayoutEffect(() => {
    const element = body.current;
    if (
      !element ||
      !navigation.open ||
      typeof ResizeObserver === "undefined" ||
      (CSS.supports("anchor-scope: --header") && CSS.supports("top: anchor(--header bottom)"))
    )
      return undefined;
    // Older engines cannot anchor the navigation drawer to its adjacent area header.
    let header: HTMLElement | null;
    const measure = () => {
      const top = header ? header.getBoundingClientRect().bottom - element.getBoundingClientRect().top : 0;
      element.style.setProperty("--app-layout-navigation-top", top + "px");
    };
    const resize = new ResizeObserver(measure);
    const bind = () => {
      const layout = element.querySelector(":scope > [data-window-layout]:not([hidden])");
      const next = layout?.querySelector<HTMLElement>(
        ":scope > [data-window-columns]:not([hidden]) > [data-window-column]:not([hidden]) > [data-window-header='primary']:not([hidden])",
      );
      if (header === (next ?? null)) return;
      resize.disconnect();
      header = next ?? null;
      if (header) resize.observe(header);
      measure();
    };
    bind();
    const areaObserver = new MutationObserver(bind);
    areaObserver.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "data-window-header"],
    });
    return () => {
      areaObserver.disconnect();
      resize.disconnect();
      element.style.removeProperty("--app-layout-navigation-top");
    };
  }, [navigation.open]);
  const ready = !chrome.diagnostic || chrome.diagnostic === "host-mismatch";
  const style: CSSProperties & { "--app-layout-header-height"?: string } = {
    "--app-layout-header-height": headerMinHeight === undefined ? undefined : `${headerMinHeight}px`,
  };
  return (
    <ShellChromeContext.Provider value={headerMode === "fused" && ready}>
      <div
        className="app-shell"
        style={style}
        data-header-mode={headerMode}
        data-chrome-ready={ready ? "" : undefined}
        data-navigation-open={navigation.open}
        data-navigation-shell={navigationProps.navigation ? "" : undefined}
      >
        {headerMode === "standalone" && (
          <header className="shell-titlebar">
            <div
              className="shell-titlebar-content"
              data-window-safe-area-owner={ready ? "" : undefined}
              {...getDragRegionProps()}
            >
              <strong>{title}</strong>
              <div {...getInteractiveProps()}>{actions}</div>
            </div>
          </header>
        )}
        <div className="shell-body" ref={body}>
          {navigationProps.navigation && (
            <nav id={navigationId} className="shell-nav" aria-label={navigationProps.navigationLabel ?? "App areas"}>
              <div className="shell-nav-chrome" {...getDragRegionProps()} aria-hidden="true" />
              <div className="shell-nav-content" {...getInteractiveProps()}>
                <button
                  data-native-control=""
                  type="button"
                  className="shell-navigation-toggle"
                  onClick={() => navigation.setOpen(false)}
                >
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
            data-native-control=""
            id={`${navigationId}-trigger`}
            type="button"
            className="shell-navigation-toggle shell-navigation-trigger"
            {...getInteractiveProps()}
            aria-expanded={navigation.open}
            aria-controls={navigationId}
            onClick={() => navigation.setOpen(!navigation.open)}
          >
            Switch area
          </button>
        )}
      </div>
    </ShellChromeContext.Provider>
  );
}
