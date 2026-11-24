import { VisualSettings } from "~/components/appearance-settings";
import { AppAreaLayout } from "~/layouts/app-area/app-area-layout";
import { BasicShell } from "~/layouts/app-shell/app-shell";

import classes from "./settings.route.module.css";

export const meta = () => [{ title: "Application settings" }];

export default function Settings() {
  return (
    <BasicShell title="Application settings">
      <AppAreaLayout areaId="settings" contentAs="main" title="Application settings">
        <div className={classes.settings}>
          <VisualSettings />
        </div>
      </AppAreaLayout>
    </BasicShell>
  );
}
