import { TextInput } from "@mantine/core";
import { Link, useOutletContext, useSearchParams } from "react-router";

import { VisualSettings } from "~/components/appearance-settings";
import { useAppEnvironment } from "~/managers/environment/hooks";

import type { Route } from "./+types/home.route";
import { DemoIcon } from "./demo-icon";
import type { DraftState } from "./demo.layout";
import { PipelineOverview } from "./pipeline-overview";
import { Welcome } from "./welcome";

import classes from "./home.route.module.css";

export const meta: Route.MetaFunction = () => [
  { title: "Layout foundation" },
  { name: "description", content: "Web and desktop layout foundation" },
];

export default function Home() {
  const [params, setParams] = useSearchParams();
  const [note, setNote] = useOutletContext<DraftState>();
  const environment = useAppEnvironment();
  const headerMode = params.get("header") === "standalone" ? "standalone" : "fused";
  function choose(key: string, value: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set(key, value);
      return next;
    });
  }
  return (
    <div className={classes.layoutDemo}>
      <header className={classes.pageHeader}>
        <div>
          <h1>Leads</h1>
          <p className={classes.caption}>Sales pipeline overview</p>
        </div>
        <div className={classes.demoLaunch}>
          <Link data-native-control="" to="/chat" target="_blank" rel="noopener">
            Chat demo <DemoIcon name="arrow" />
          </Link>

          <Link data-native-control="" to="/settings" target="_blank" rel="noopener">
            Settings <DemoIcon name="arrow" />
          </Link>
        </div>
      </header>

      <PipelineOverview />
      <div className={classes.demoGrid}>
        <section data-demo-draft className={classes.demoCard} aria-labelledby="scratchpad-title">
          <div className={classes.demoCardHeading}>
            <div className={classes.demoIconBox}>
              <DemoIcon name="file" />
            </div>
            <div>
              <h2 id="scratchpad-title">Meridian Labs</h2>
              <p>Inbound lead · Product walkthrough requested</p>
            </div>
          </div>
          <div>
            <TextInput
              id="scratchpad"
              label="Follow-up note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Start writing…"
              aria-describedby="draft-hint"
            />
          </div>
          <p id="draft-hint" className={classes.demoCardFootnote}>
            Kept while you resize or change the title bar. Cleared on reload.
          </p>
        </section>
        <section
          tabIndex={-1}
          id="layout-settings"
          className={classes.demoCard}
          aria-labelledby="layout-settings-title"
        >
          <div className={classes.demoCardHeading}>
            <div className={classes.demoIconBox}>
              <DemoIcon name="settings" />
            </div>
            <div>
              <h2 id="layout-settings-title">Layout settings</h2>
            </div>
          </div>
          <div className={classes.layoutDemoControls} data-demo-controls>
            <label className={classes.nativeField}>
              Title bar
              <select
                data-native-control=""
                data-demo-header
                value={headerMode}
                onChange={(event) => choose("header", event.target.value)}
              >
                <option value="fused">Fused</option>
                <option value="standalone">Standalone</option>
              </select>
            </label>
          </div>
          <p className={classes.caption}>Host: {environment.shell.kind}.</p>
        </section>
      </div>

      <VisualSettings />
      <Welcome />
      <footer className={classes.demoFooter}>
        <span>Built to feel at home, on web and desktop.</span>
        <span>Layout foundation</span>
      </footer>
    </div>
  );
}
