import { useContext, useId, type ReactNode } from "react";

import { ShellChromeContext } from "~/layouts/app-shell/chrome-context";
import { usePanelEscape, usePanelState } from "~/layouts/use-panel-state";
import { getInteractiveProps } from "~/managers/environment/dom-props";

export interface AppAreaLayoutProps {
  areaId: string;
  /** Set main once per page. Other layout containers use div. */
  contentAs?: "div" | "main";
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  sidebar?: ReactNode;
  sidebarTitle?: ReactNode;
  sidebarOpen?: boolean;
  defaultSidebarOpen?: boolean;
  onSidebarOpenChange?: (open: boolean) => void;
  auxiliary?: ReactNode;
  auxiliaryTitle?: ReactNode;
  auxiliaryOpen?: boolean;
  defaultAuxiliaryOpen?: boolean;
  onAuxiliaryOpenChange?: (open: boolean) => void;
}

/** Lays out the sidebar, main content and auxiliary panel within one app area. CSS adapts to its width. */
export function AppAreaLayout({
  areaId,
  contentAs: Content = "div",
  title,
  actions,
  children,
  sidebar,
  sidebarTitle = "Sidebar",
  sidebarOpen,
  defaultSidebarOpen = false,
  onSidebarOpenChange,
  auxiliary,
  auxiliaryTitle = "Auxiliary workspace",
  auxiliaryOpen,
  defaultAuxiliaryOpen = false,
  onAuxiliaryOpenChange,
}: AppAreaLayoutProps) {
  const fused = useContext(ShellChromeContext);
  const sidebarId = useId();
  const auxiliaryId = useId();
  const side = usePanelState(sidebarOpen, defaultSidebarOpen, onSidebarOpenChange, `${sidebarId}-trigger`);
  const aux = usePanelState(auxiliaryOpen, defaultAuxiliaryOpen, onAuxiliaryOpenChange, `${auxiliaryId}-trigger`);
  usePanelEscape(side.open, side.setOpen, sidebarId);
  usePanelEscape(aux.open, aux.setOpen, auxiliaryId);
  return (
    <section
      className="app-area-layout"
      data-area-id={areaId}
      data-chrome-complete={fused ? "" : undefined}
      data-sidebar-open={Boolean(sidebar) && side.open}
      data-auxiliary-open={Boolean(auxiliary) && aux.open}
    >
      <div className="app-area-columns">
        {sidebar && (
          <aside
            id={sidebarId}
            className="app-area-panel app-area-sidebar"
            hidden={!side.open}
            aria-label="Area sidebar"
          >
            <header className="app-area-header" data-chrome-edge="start" data-window-drag={fused ? "" : undefined}>
              <strong className="app-area-header-title">{sidebarTitle}</strong>
              <button
                data-native-control=""
                {...getInteractiveProps()}
                type="button"
                onClick={() => side.setOpen(false)}
                aria-label="Close sidebar"
              >
                ×
              </button>
            </header>
            <div className="app-area-scroll" data-scroll-restoration-id={`${areaId}:sidebar`}>
              {sidebar}
            </div>
          </aside>
        )}
        <section
          className="app-area-panel app-area-workspace"
          aria-label={Content === "main" ? undefined : "Workspace"}
        >
          <header className="app-area-header" data-chrome-edge="workspace" data-window-drag={fused ? "" : undefined}>
            {sidebar && (
              <button
                data-native-control=""
                id={`${sidebarId}-trigger`}
                data-area-panel-toggle="sidebar"
                {...getInteractiveProps()}
                type="button"
                aria-expanded={side.open}
                aria-controls={sidebarId}
                onClick={() => side.setOpen(!side.open)}
              >
                Sidebar
              </button>
            )}
            <strong className="app-area-header-title">{title}</strong>
            <div {...getInteractiveProps()}>{actions}</div>
            {auxiliary && (
              <button
                data-native-control=""
                id={`${auxiliaryId}-trigger`}
                data-area-panel-toggle="auxiliary"
                {...getInteractiveProps()}
                type="button"
                aria-expanded={aux.open}
                aria-controls={auxiliaryId}
                onClick={() => aux.setOpen(!aux.open)}
              >
                Auxiliary
              </button>
            )}
          </header>
          <Content className="app-area-scroll" data-scroll-restoration-id={`${areaId}:workspace`}>
            {children}
          </Content>
        </section>
        {auxiliary && (
          <aside
            id={auxiliaryId}
            className="app-area-panel app-area-auxiliary"
            hidden={!aux.open}
            aria-label="Auxiliary workspace"
          >
            <header className="app-area-header" data-chrome-edge="end" data-window-drag={fused ? "" : undefined}>
              <strong className="app-area-header-title">{auxiliaryTitle}</strong>
              <button
                data-native-control=""
                {...getInteractiveProps()}
                type="button"
                onClick={() => aux.setOpen(false)}
                aria-label="Close auxiliary workspace"
              >
                ×
              </button>
            </header>
            <div className="app-area-scroll" data-scroll-restoration-id={`${areaId}:auxiliary`}>
              {auxiliary}
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}
