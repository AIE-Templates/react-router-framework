import { TextInput } from "@mantine/core";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";

import { BasicShell, NavigationShell } from "../layouts/app-shell/app-shell";
import { ModuleLayout } from "../layouts/module/module-layout";
import { VisualSettings } from "../managers/visual/settings";
import { useAppEnvironment } from "../providers/environment";
import { DemoIcon } from "../welcome/demo-icon";
import { Welcome } from "../welcome/welcome";
import type { Route } from "./+types/home";

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
        <div className="demo-panel">
          <p className="demo-eyebrow">On this page</p>
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
          <p className="demo-panel-hint">
            A little space for your module&apos;s navigation. Independent of the application rail.
          </p>
        </div>
      }
      auxiliaryTitle="Inspector"
      auxiliary={
        <div className="demo-panel">
          <p className="demo-eyebrow">Current workspace</p>
          <dl className="demo-properties">
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
          <p className="demo-panel-hint">Keep supporting details here while the main workspace stays focused.</p>
        </div>
      }
    >
      <div className="layout-demo">
        <div className="demo-breadcrumb">
          <span>Workspace</span>
          <span aria-hidden="true">/</span>
          <span>Overview</span>
        </div>
        <header className="demo-intro">
          <div className="demo-eyebrow">
            <DemoIcon name="layers" />
            Your starting point
          </div>
          <h1>One application, three layout layers</h1>
          <p>A quiet workspace, ready to make your own. Explore the layout, open a panel, and find the right fit.</p>
          <span className="demo-badge">
            <span className="demo-status-dot" aria-hidden="true" />
            Host: {environment.shell.kind}.
          </span>
        </header>

        <VisualSettings />
        <div className="demo-grid">
          <section id="layout-settings" className="demo-card" aria-labelledby="layout-settings-title">
            <div className="demo-card-heading">
              <div className="demo-icon-box">
                <DemoIcon name="settings" />
              </div>
              <div>
                <h2 id="layout-settings-title">Make room for your work</h2>
                <p>Two small choices. A different workspace.</p>
              </div>
            </div>
            <div className="layout-demo-controls">
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
              className="demo-layout-preview"
              data-basic={basic}
              data-standalone={headerMode === "standalone"}
              aria-hidden="true"
            >
              <div className="demo-preview-title">
                <i />
                <i />
                <i />
              </div>
              <div className="demo-preview-rail">
                <i />
                <i />
                <i />
              </div>
              <div className="demo-preview-body">
                <span />
                <div>
                  <i />
                  <i />
                </div>
                <span />
              </div>
              <span className="demo-preview-caption">
                {basic ? "Basic shell" : "Navigation shell"} · {headerMode}
              </span>
            </div>
            <p className="demo-card-footnote">Resize the window. Your workspace adapts with you.</p>
          </section>

          <section id="scratchpad" className="demo-card" aria-labelledby="scratchpad-title">
            <div className="demo-card-heading">
              <div className="demo-icon-box">
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
            <div className="demo-note-preview">
              <div className="demo-note-meta">
                <span>SCRATCHPAD</span>
                <span className="demo-badge">Local draft</span>
              </div>
              <p className={note ? "demo-note-text" : "demo-note-text demo-note-empty"}>
                {note || "Every great workspace starts with a little space to think."}
              </p>
              <div className="demo-note-lines" aria-hidden="true">
                <i />
                <i />
              </div>
            </div>
            <p id="draft-hint" className="demo-card-footnote">
              Kept while you resize or change the title bar. Cleared on reload.
            </p>
          </section>
        </div>

        <Welcome />
        <footer className="demo-footer">
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
          <span className="demo-brand" title="Layout foundation" aria-hidden="true">
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
          <span className="demo-rail-footer" aria-hidden="true">
            LF
          </span>
        </>
      }
    >
      {module}
    </NavigationShell>
  );
}
