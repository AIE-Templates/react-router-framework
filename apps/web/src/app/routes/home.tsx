import { useState } from "react";
import { useSearchParams } from "react-router";

import { BasicShell, NavigationShell } from "../layouts/app-shell/app-shell";
import { ModuleLayout } from "../layouts/module/module-layout";
import { useAppEnvironment } from "../providers/environment";
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
  const module = (
    <ModuleLayout
      moduleId="welcome"
      title="Layout foundation"
      sidebarTitle="Module navigation"
      sidebar={<p>This sidebar belongs to the current module.</p>}
      auxiliaryTitle="Inspector"
      auxiliary={<p>Auxiliary state is independent of application navigation.</p>}
    >
      <div className="layout-demo">
        <h1>One application, three layout layers</h1>
        <p>Host: {environment.shell.kind}. Resize the window to review compact, medium and expanded layouts.</p>
        <div className="layout-demo-controls">
          <label>
            App shell{" "}
            <select
              value={params.get("shell") === "basic" ? "basic" : "navigation"}
              onChange={(event) => choose("shell", event.target.value)}
            >
              <option value="navigation">Navigation</option>
              <option value="basic">Basic</option>
            </select>
          </label>
          <label>
            Title bar{" "}
            <select value={headerMode} onChange={(event) => choose("header", event.target.value)}>
              <option value="fused">Fused</option>
              <option value="standalone">Standalone</option>
            </select>
          </label>
        </div>
        <label>
          Module draft{" "}
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="State survives width changes"
          />
        </label>
      </div>
      <Welcome />
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
          <a href="/?shell=navigation">Home</a>
          <a href="https://reactrouter.com/docs">Docs</a>
        </>
      }
    >
      {module}
    </NavigationShell>
  );
}
