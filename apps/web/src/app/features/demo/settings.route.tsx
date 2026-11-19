import { VisualSettings } from "~/components/appearance-settings";
import { BasicShell } from "~/layouts/app-shell/app-shell";
import { ModuleLayout } from "~/layouts/module/module-layout";

import classes from "./settings.route.module.css";

export const meta = () => [{ title: "Application settings" }];

export default function Settings() {
  return (
    <BasicShell title="Application settings">
      <ModuleLayout moduleId="settings" contentAs="main" title="Application settings">
        <div className={classes.settings}>
          <VisualSettings />
        </div>
      </ModuleLayout>
    </BasicShell>
  );
}
