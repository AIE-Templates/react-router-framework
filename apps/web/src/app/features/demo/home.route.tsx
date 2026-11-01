import { TextInput } from "@mantine/core";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";

import { VisualSettings } from "~/components/appearance-settings";
import { BasicShell, NavigationShell } from "~/layouts/app-shell/app-shell";
import { ModuleLayout } from "~/layouts/module/module-layout";
import { useAppEnvironment } from "~/managers/environment/hooks";

import type { Route } from "./+types/home.route";
import { DemoIcon } from "./demo-icon";
import { Welcome } from "./welcome";

import classes from "./home.route.module.css";

export const meta: Route.MetaFunction = () => [
  { title: "Layout foundation" },
  { name: "description", content: "Web and desktop layout foundation" },
];

export default function Home() {
  const [params, setParams] = useSearchParams();
  const [note, setNote] = useState("");
  const environment = useAppEnvironment();
  const basic = params.get("shell") === "basic";
  const headerMode = params.get("header") === "standalone" ? "standalone" : "fused";
  function choose(key: string, value: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set(key, value);
      return next;
    });
  }
  const homeParams = new URLSearchParams(params);
  homeParams.set("shell", "navigation");
  const module = (
    <ModuleLayout
      moduleId="welcome"
      contentAs="main"
      title="Layout foundation"
      sidebarTitle="Module navigation"
      sidebar={
        <div className={classes.demoPanel}>
          <p className={classes.demoEyebrow}>On this page</p>
          <a href="#layout-settings">
            <DemoIcon name="settings" />
            Layout settings
          </a>
          <a href="#scratchpad">
            <DemoIcon name="file" />
            Scratchpad
          </a>
          <a href="#resources">
            <DemoIcon name="book" />
            Resources
          </a>
          <p className={classes.demoPanelHint}>
            A little space for your module&apos;s navigation. Independent of the application rail.
          </p>
        </div>
      }
      auxiliaryTitle="Inspector"
      auxiliary={
        <div className={classes.demoPanel}>
          <p className={classes.demoEyebrow}>Current workspace</p>
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
          <p className={classes.demoPanelHint}>Keep supporting details here while the main workspace stays focused.</p>
        </div>
      }
    >
      <div className={classes.layoutDemo}>
        <div className={classes.demoBreadcrumb}>
          <span>Workspace</span>
          <span aria-hidden="true">/</span>
          <span>Overview</span>
        </div>
        <header className={classes.demoIntro}>
          <div className={classes.demoEyebrow}>
            <DemoIcon name="layers" />
            Your starting point
          </div>
          <h1>One application, three layout layers</h1>
          <p>A quiet workspace, ready to make your own. Explore the layout, open a panel, and find the right fit.</p>
          <span className={classes.demoBadge}>
            <span className={classes.demoStatusDot} aria-hidden="true" />
            Host: {environment.shell.kind}.
          </span>
        </header>

        <VisualSettings />
        <div className={classes.demoGrid}>
          <section id="layout-settings" className={classes.demoCard} aria-labelledby="layout-settings-title">
            <div className={classes.demoCardHeading}>
              <div className={classes.demoIconBox}>
                <DemoIcon name="settings" />
              </div>
              <div>
                <h2 id="layout-settings-title">Make room for your work</h2>
                <p>Two small choices. A different workspace.</p>
              </div>
            </div>
            <div className={classes.layoutDemoControls} data-demo-controls>
              <label>
                App shell
                <select
                  value={basic ? "basic" : "navigation"}
                  onChange={(event) => choose("shell", event.target.value)}
                >
                  <option value="navigation">Navigation</option>
                  <option value="basic">Basic</option>
                </select>
              </label>
              <label>
                Title bar
                <select value={headerMode} onChange={(event) => choose("header", event.target.value)}>
                  <option value="fused">Fused</option>
                  <option value="standalone">Standalone</option>
                </select>
              </label>
            </div>
            <div
              className={classes.demoLayoutPreview}
              data-basic={basic}
              data-standalone={headerMode === "standalone"}
              aria-hidden="true"
            >
              <div className={classes.demoPreviewTitle}>
                <i />
                <i />
                <i />
              </div>
              <div className={classes.demoPreviewRail}>
                <i />
                <i />
                <i />
              </div>
              <div className={classes.demoPreviewBody}>
                <span />
                <div>
                  <i />
                  <i />
                </div>
                <span />
              </div>
              <span className={classes.demoPreviewCaption}>
                {basic ? "Basic shell" : "Navigation shell"} · {headerMode}
              </span>
            </div>
            <p className={classes.demoCardFootnote}>Resize the window. Your workspace adapts with you.</p>
          </section>

          <section id="scratchpad" data-demo-draft className={classes.demoCard} aria-labelledby="scratchpad-title">
            <div className={classes.demoCardHeading}>
              <div className={classes.demoIconBox}>
                <DemoIcon name="file" />
              </div>
              <div>
                <h2 id="scratchpad-title">A place to start</h2>
                <p>Try a thought, a task, or your next big idea.</p>
              </div>
            </div>
            <div className="demo-draft-label">
              <TextInput
                label="Module draft"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="What would you like to build?"
                aria-describedby="draft-hint"
              />
            </div>
            <div className={classes.demoNotePreview}>
              <div className={classes.demoNoteMeta}>
                <span>SCRATCHPAD</span>
                <span className={classes.demoBadge}>Local draft</span>
              </div>
              <p className={`${classes.demoNoteText}${note ? "" : ` ${classes.demoNoteEmpty}`}`}>
                {note || "Every great workspace starts with a little space to think."}
              </p>
              <div className={classes.demoNoteLines} aria-hidden="true">
                <i />
                <i />
              </div>
            </div>
            <p id="draft-hint" className={classes.demoCardFootnote}>
              Kept while you resize or change the title bar. Cleared on reload.
            </p>
          </section>
        </div>

        <Welcome />
        <footer className={classes.demoFooter}>
          <span>Built to feel at home, on web and desktop.</span>
          <span>Layout foundation</span>
        </footer>
      </div>
    </ModuleLayout>
  );
  return basic ? (
    <BasicShell title="Layout foundation" headerMode={headerMode}>
      {module}
    </BasicShell>
  ) : (
    <NavigationShell
      title="Layout foundation"
      headerMode={headerMode}
      navigation={
        <>
          <span className={classes.demoBrand} title="Layout foundation" aria-hidden="true">
            <DemoIcon name="layers" />
          </span>
          <Link to={{ search: `?${homeParams.toString()}` }} aria-current="page">
            <DemoIcon name="home" />
            <span>Home</span>
          </Link>
          <a href="https://reactrouter.com/docs">
            <DemoIcon name="book" />
            <span>Docs</span>
          </a>
          <span className={classes.demoRailFooter} aria-hidden="true">
            LF
          </span>
        </>
      }
    >
      {module}
    </NavigationShell>
  );
}
