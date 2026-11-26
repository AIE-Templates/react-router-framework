import { useCallback, useState, type MouseEvent } from "react";
import { NavLink, Outlet, useLocation, useSearchParams } from "react-router";

import { AppAreaLayout } from "~/layouts/app-area/app-area-layout";
import { useAppEnvironment } from "~/managers/environment/hooks";

import { AccountMenu } from "./account-menu";
import { DemoIcon } from "./demo-icon";
import type { DraftState } from "./demo.layout";

import classes from "./home.route.module.css";

export function CrmArea({ basic, report, draft }: { basic: boolean; report: boolean; draft: DraftState }) {
  const { search } = useLocation();
  const [params, setParams] = useSearchParams();
  const environment = useAppEnvironment();
  const reportArea = !basic && report;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Use the actual container layout so a compact drawer never covers the page on entry.
  const initializeSidebar = useCallback((nav: HTMLElement | null) => {
    const panel = nav?.closest("aside");
    if (panel) setSidebarOpen(getComputedStyle(panel).position === "static");
  }, []);
  function followPage(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const panel = event.currentTarget.closest("aside");
    if (panel && getComputedStyle(panel).position === "absolute") setSidebarOpen(false);
  }
  const title = basic ? "CRM" : reportArea ? "Reports" : "Sales";
  const headerMode = params.get("header") === "standalone" ? "standalone" : "fused";
  return (
    <AppAreaLayout
      areaId={basic ? "crm" : reportArea ? "reports" : "sales"}
      title={title}
      contentAs="main"
      sidebarOpen={sidebarOpen}
      onSidebarOpenChange={setSidebarOpen}
      sidebarTitle={
        basic ? (
          <span className={classes.brand}>
            <DemoIcon name="layers" />
            Sales CRM
          </span>
        ) : (
          title
        )
      }
      sidebar={
        !reportArea && (
          <div className={classes.sidebarBody}>
            <nav ref={initializeSidebar} className={classes.demoPanel} aria-label={title + " pages"}>
              <NavLink onClick={followPage} data-native-control="" end to={{ pathname: "/", search }}>
                <DemoIcon name="people" /> Leads
              </NavLink>
              <NavLink onClick={followPage} data-native-control="" to={{ pathname: "/deals", search }}>
                <DemoIcon name="briefcase" /> Deals
              </NavLink>
              {basic && (
                <NavLink onClick={followPage} data-native-control="" to={{ pathname: "/reports/sales", search }}>
                  <DemoIcon name="chart" /> Sales report
                </NavLink>
              )}
            </nav>
            {basic && <AccountMenu />}
          </div>
        )
      }
      auxiliaryTitle="Inspector"
      auxiliary={
        <div className={classes.demoPanel}>
          <dl className={classes.demoProperties}>
            <div>
              <dt>App shell</dt>
              <dd>{basic ? "Basic" : "Navigation"}</dd>
            </div>
            <div>
              <dt>Title bar</dt>
              <dd>{headerMode === "fused" ? "Fused" : "Standalone"}</dd>
            </div>
            <div>
              <dt>Host</dt>
              <dd>{environment.shell.kind}</dd>
            </div>
          </dl>
        </div>
      }
    >
      <div className={classes.layoutSelector}>
        <a href="/?layout=editor" target="_blank" rel="noopener" data-native-control="">
          Open editor
        </a>
        <label className={classes.nativeField}>
          App shell
          <select
            data-native-control=""
            data-demo-shell
            value={basic ? "basic" : "navigation"}
            onChange={(event) => {
              const next = new URLSearchParams(params);
              next.set("shell", event.target.value);
              setParams(next);
            }}
          >
            <option value="basic">Single area</option>
            <option value="navigation">Multiple areas</option>
          </select>
        </label>
      </div>
      <Outlet context={draft} />
    </AppAreaLayout>
  );
}
