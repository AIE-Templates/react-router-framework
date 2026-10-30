import { useContext, useId, type ReactNode } from "react";

import { getInteractiveProps } from "../../providers/environment";
import { ShellChromeContext } from "../app-shell/chrome-context";
import { usePanelEscape, usePanelState } from "../use-panel-state";

export interface ModuleLayoutProps {
  moduleId: string;
  /** Opt in once per page; nested or sibling modules keep the default div. */
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

/** A module-scoped sidebar, workspace and optional auxiliary workspace. CSS owns width adaptation. */
export function ModuleLayout({
  moduleId,
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
}: ModuleLayoutProps) {
  const fused = useContext(ShellChromeContext);
  const sidebarId = useId();
  const auxiliaryId = useId();
  const side = usePanelState(sidebarOpen, defaultSidebarOpen, onSidebarOpenChange, `${sidebarId}-trigger`);
  const aux = usePanelState(auxiliaryOpen, defaultAuxiliaryOpen, onAuxiliaryOpenChange, `${auxiliaryId}-trigger`);
  usePanelEscape(side.open, side.setOpen, sidebarId);
  usePanelEscape(aux.open, aux.setOpen, auxiliaryId);
  return (
    <section
      className="module-layout"
      data-module-id={moduleId}
      data-chrome-complete={fused ? "" : undefined}
      data-sidebar-open={Boolean(sidebar) && side.open}
      data-auxiliary-open={Boolean(auxiliary) && aux.open}
    >
      <div className="module-columns">
        {sidebar && (
          <aside id={sidebarId} className="module-panel module-sidebar" hidden={!side.open} aria-label="Module sidebar">
            <header className="module-header" data-chrome-edge="start" data-window-drag={fused ? "" : undefined}>
              <strong className="module-header-title">{sidebarTitle}</strong>
              <button
                {...getInteractiveProps()}
                type="button"
                onClick={() => side.setOpen(false)}
                aria-label="Close sidebar"
              >
                ×
              </button>
            </header>
            <div className="module-scroll" data-scroll-restoration-id={`${moduleId}:sidebar`}>
              {sidebar}
            </div>
          </aside>
        )}
        <section className="module-panel module-workspace" aria-label="Workspace">
          <header className="module-header" data-chrome-edge="workspace" data-window-drag={fused ? "" : undefined}>
            {sidebar && (
              <button
                id={`${sidebarId}-trigger`}
                {...getInteractiveProps()}
                type="button"
                aria-expanded={side.open}
                aria-controls={sidebarId}
                onClick={() => side.setOpen(!side.open)}
              >
                Sidebar
              </button>
            )}
            <strong className="module-header-title">{title}</strong>
            <div {...getInteractiveProps()}>{actions}</div>
            {auxiliary && (
              <button
                id={`${auxiliaryId}-trigger`}
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
          <Content className="module-scroll" data-scroll-restoration-id={`${moduleId}:workspace`}>
            {children}
          </Content>
        </section>
        {auxiliary && (
          <aside
            id={auxiliaryId}
            className="module-panel module-auxiliary"
            hidden={!aux.open}
            aria-label="Auxiliary workspace"
          >
            <header className="module-header" data-chrome-edge="end" data-window-drag={fused ? "" : undefined}>
              <strong className="module-header-title">{auxiliaryTitle}</strong>
              <button
                {...getInteractiveProps()}
                type="button"
                onClick={() => aux.setOpen(false)}
                aria-label="Close auxiliary workspace"
              >
                ×
              </button>
            </header>
            <div className="module-scroll" data-scroll-restoration-id={`${moduleId}:auxiliary`}>
              {auxiliary}
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}
