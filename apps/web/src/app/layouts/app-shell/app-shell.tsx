import type { OverlayAppearance } from "@repo/shared";
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";

import { usePanelEscape, usePanelState } from "~/layouts/use-panel-state";
import { useEnvironmentRuntime } from "~/managers/environment/context";
import { getInteractiveProps } from "~/managers/environment/dom-props";
import { useAppEnvironment } from "~/managers/environment/hooks";

import { ShellChromeContext } from "./chrome-context";

export interface BasicShellProps {
  children: ReactNode;
  title?: ReactNode;
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
  const chrome = useAppEnvironment();
  const runtime = useEnvironmentRuntime();
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
  const { color, symbolColor, height } = overlayAppearance ?? {};
  const ownsAppearance =
    chrome.enhancement === "available" && (color !== undefined || symbolColor !== undefined || height !== undefined);
  useEffect(() => {
    if (ownsAppearance) void runtime.declareOverlayAppearance(navigationId, { color, symbolColor, height });
  }, [runtime, navigationId, ownsAppearance, color, symbolColor, height]);
  useEffect(() => {
    if (ownsAppearance)
      return () => {
        void runtime.declareOverlayAppearance(navigationId, null);
      };
    return undefined;
  }, [runtime, navigationId, ownsAppearance]);
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
        <div className="shell-body" ref={body}>
          {navigationProps.navigation && (
            <nav id={navigationId} className="shell-nav" aria-label={navigationProps.navigationLabel ?? "App areas"}>
              <div className="shell-nav-chrome" data-window-drag="" aria-hidden="true" />
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
