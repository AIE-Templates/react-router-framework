import { PRODUCT_HEADER_HEIGHT } from "@repo/shared";
import { useState } from "react";
import { Link, useMatch, useSearchParams } from "react-router";

import { BasicShell, NavigationShell } from "~/layouts/app-shell/app-shell";

import { AccountMenu } from "./account-menu";
import { CrmArea } from "./crm-area";
import { DemoIcon } from "./demo-icon";
import { EditorArea } from "./editor-area";

import classes from "./home.route.module.css";

export type DraftState = [string, (value: string) => void];

export default function DemoLayout() {
  const [params] = useSearchParams();
  const report = useMatch("/reports/sales");
  const headerMode = params.get("header") === "standalone" ? "standalone" : "fused";
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const draft = useState("");
  const basic = params.get("shell") === "basic";
  if (params.get("layout") === "editor") {
    return (
      <BasicShell title="Editor" headerMinHeight={PRODUCT_HEADER_HEIGHT} headerMode={headerMode}>
        <EditorArea />
      </BasicShell>
    );
  }
  const area = <CrmArea basic={basic} report={Boolean(report)} draft={draft} />;
  if (basic) {
    return (
      <BasicShell title="CRM" headerMinHeight={PRODUCT_HEADER_HEIGHT} headerMode={headerMode}>
        {area}
      </BasicShell>
    );
  }
  const search = new URLSearchParams(params);
  search.set("shell", "navigation");
  return (
    <NavigationShell
      title={report ? "Reports" : "Sales"}
      headerMinHeight={PRODUCT_HEADER_HEIGHT}
      headerMode={headerMode}
      navigationOpen={switcherOpen}
      onNavigationOpenChange={setSwitcherOpen}
      navigation={
        <>
          <span className={classes.railBrand} title="Sales CRM">
            <DemoIcon name="layers" />
            <span className="sr-only">Sales CRM</span>
          </span>
          <Link
            onClick={() => setSwitcherOpen(false)}
            data-native-control=""
            aria-current={report ? undefined : "true"}
            to={{ pathname: "/", search: search.toString() }}
          >
            <DemoIcon name="book" />
            Sales
          </Link>
          <Link
            onClick={() => setSwitcherOpen(false)}
            data-native-control=""
            aria-current={report ? "page" : undefined}
            to={{ pathname: "/reports/sales", search: search.toString() }}
          >
            <DemoIcon name="file" />
            Reports
          </Link>
          <AccountMenu compact />
        </>
      }
    >
      {area}
    </NavigationShell>
  );
}
