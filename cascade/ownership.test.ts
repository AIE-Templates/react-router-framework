import assert from "node:assert/strict";
import { test } from "node:test";

import { ownedFileViolation, retiredWebPath } from "./ownership.ts";

test("keeps the existing server-package and legacy Core boundaries", () => {
  assert.equal(ownedFileViolation("app/static/core", "packages/server/src/index.ts"), "Fullstack-owned file");
  assert.equal(ownedFileViolation("starter/base", "apps/web/src/app/window-chrome/runtime.ts"), "Core-owned file");
});

test("rejects relocated layer-owned files on branches without that layer", () => {
  const cases = [
    ["starter/fullstack", "apps/web/src/app/managers/environment/hooks.ts", "Core"],
    ["starter/base", "apps/web/src/app/styles/naming.test.ts", "Core"],
    ["app/base/core", "apps/web/src/app/managers/visual/persistence/cookie.ts", "Fullstack"],
    ["app/static/mantine", "apps/web/src/app/features/account/account.server.ts", "Fullstack"],
    ["app/base/core", "packages/shared/src/preferences.ts", "Electron"],
    ["app/fullstack/core", "apps/web/src/app/managers/visual/mantine/theme.ts", "Mantine"],
    ["platform/electron/core", "apps/web/src/app/features/demo/home.module.scss", "Mantine"],
    ["app/fullstack/mantine", "apps/web/src/app/platform/electron/context.ts", "Electron"],
  ];
  for (const [branch, path, layer] of cases)
    assert.equal(ownedFileViolation(branch, path), `${layer}-owned file`, `${branch}: ${path}`);
});

test("keeps shared visual cookie handling and records in Core", () => {
  for (const path of [
    "apps/web/src/app/config/visual-cookie.ts",
    "apps/web/src/app/managers/visual/cookie.ts",
    "apps/web/src/app/managers/visual/request-seed.ts",
    "packages/shared/src/visual-record.ts",
  ]) {
    assert.equal(ownedFileViolation("app/base/core", path), undefined, path);
    assert.equal(ownedFileViolation("starter/base", path), "Core-owned file", path);
  }
});

test("allows valid compositions and starter global styles", () => {
  for (const path of ["apps/web/src/app/styles/base.css", "apps/web/src/app/styles/index.css", "apps/web/src/app/features/demo/home.route.tsx"])
    assert.equal(ownedFileViolation("starter/base", path), undefined);
  for (const path of ["packages/server/src/index.ts", "apps/web/src/app/managers/visual/mantine/theme.ts", "apps/web/src/app/platform/electron/context.ts", "apps/desktop/src/main.ts"])
    assert.equal(ownedFileViolation("platform/electron/mantine", path), undefined);
  assert.equal(ownedFileViolation("app/base/core", "apps/web/src/app/styles/tokens.css"), undefined);
  assert.equal(ownedFileViolation("app/base/core", "docs/specs/layout.spec.md"), undefined);
});

test("rejects docs paths outside docs/specs", () => {
  assert.equal(ownedFileViolation("app/base/core", "docs/adrs/README.md"), "Non-spec docs file");
  assert.equal(ownedFileViolation("platform/electron/core", "docs/plans/foo.md"), "Non-spec docs file");
  assert.equal(ownedFileViolation("starter/base", "docs/notes.md"), "Non-spec docs file");
});

test("rejects every retired Web entry point, including all files in retired directories", () => {
  for (const path of [
    "src/app/app.css", "src/app/routes/home.tsx", "src/app/welcome/assets/logo.svg",
    "src/app/window-chrome/runtime.ts", "src/app/providers/environment.ts",
    "src/app/managers/visual/settings.tsx", "src/app/lib/shell.ts", "src/app/lib/preferences.ts",
    "visual-fallback-plugin.ts",
  ]) assert.equal(retiredWebPath(`apps/web/${path}`), true, path);
});

test("keeps valid route configuration, host infrastructure and migrated paths", () => {
  for (const path of [
    "src/app/routes.ts", "src/app/features/demo/home.route.tsx", "src/app/styles/index.css",
    "src/app/managers/environment/runtime.ts", "src/app/components/appearance-settings.tsx",
    "src/app/lib/api.ts", "src/app/platform/electron/shell.ts", "src/host/app.ts",
    "vite-plugins/visual-fallback.ts",
  ]) assert.equal(retiredWebPath(`apps/web/${path}`), false, path);
  assert.equal(retiredWebPath("apps/desktop/src/app.css"), false);
});
