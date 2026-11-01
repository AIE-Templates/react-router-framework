# Application source structure

## Features and routes

`apps/web/src/app` is the Web application root and the target of `~/`. `routes.ts` is the only URL-to-file mapping. Route modules live in their feature as `<page>.route.tsx` or `<name>.layout.tsx`, with generated types imported from `./+types/<page>.route`. Core/static page routes use client data APIs and do not declare server loaders/actions/middleware/headers or non-root HydrateFallback.

`features/main` contains the SPA 404 and can later hold application layout routes and navigation data. `features/demo` is a disposable sandbox outside the main layout: no other directory imports it. Removing its route registrations and directory removes the template home page. Feature-specific UI, state, types, hooks and pure functions stay together; feature-to-feature imports are not part of the design. Share reusable UI through components/layouts and reusable infrastructure through hooks/managers/services/lib/utils/config as appropriate.

The dependency direction is recommended, not lint-enforced. App imports use `~/` when crossing directories; `./` may reference the same directory or children. The import/no-relative-parent-imports lint rule forbids parent-relative imports within apps/*/src/**; build configuration, scripts and e2e files remain outside its scope. Packages use workspace names and retain package-internal relative imports. Do not add barrel index.ts files under src/app. Tests stay beside source unless their dependency on the real host requires src/host.

## Infrastructure owners

`managers/environment` contains runtime, context, hooks and DOM-prop helpers. AppRoot creates the environment runtime directly; it is not a ManagersRegistry member. Host-independent contracts remain in Core; protocols and native synchronization belong to platform-specific layers. `managers/visual` owns visual state, lifecycle and adapters. `components/appearance-settings.tsx` is shared appearance UI, not a manager implementation.

`providers` contains application composition points. Production root/entry.server code consumes them; `testing/render.tsx` composes AppRoot and AppUiProvider for ordinary UI tests. Its optional `appRoot` settings seed the real AppRoot. Router context remains explicit. Provider lifecycle/initial-state/unmount tests may mount providers directly; the helper is not mandatory for those tests. Only tests import testing utilities.

`config` holds data-only configuration. `lib` holds side-effecting infrastructure, `utils` holds pure helpers, and `services` is the optional future location for resource-oriented business APIs. This migration does not introduce a Core ApiClient or empty services directory. Production app source does not import src/host; host integration tests may import the real application under test. Host tests must explicitly choose their Vitest environment.

## Styles and identifiers

The global entry is `styles/index.css`, with layer order `theme, base, mantine, components, utilities`. Base document rules, semantic tokens and shell styles live in base.css, tokens.css and shell.css. Core provides an empty ui.css integration slot, populated by UI-library layers. Component styles are colocated CSS Modules, using camelCase classes and the import name `classes`; module rules also belong to `@layer components` so utility overrides retain their intended order. UI-library layers may prefer SCSS Modules without converting inherited Core modules.

`CHROME_SAFETY_CSS` in `layouts/app-shell/chrome-safety.ts` is an explicit exception: preserve inline delivery and unlayered rules so window safety does not wait for external stylesheets, providers or bootstrap.

Core semantic variables use `--app-`, including `--app-color-*`, `--app-font-sans`, `--app-radius` and `--app-shadow-surface`. Tailwind and UI-library variables derive from them. `--app-shell-*` is reserved for Mantine AppShell. Feature-private variables use exactly `--<feature>-` on that feature's root rather than :root. Feature names cannot occupy application, Mantine or Tailwind theme namespaces. Data attributes use domain-name without an application prefix; preserve existing and third-party attributes.

`styles/naming.test.ts` scans actual CSS/SCSS and TS/TSX source, including CSS template strings, CSS-variable object keys and literal setProperty calls. It excludes test files and comments and skips nested `@theme` blocks. Reads are not definitions. Mantine/Tailwind library namespaces are exempt; other reviewed third-party definitions can use a same-line `/* naming-allow: reason */` or `// naming-allow: reason` comment. Do not suppress an entire file. Native `light-dark()` and bare `rem()` are prohibited in project styles; namespaced `mantine.rem()` remains valid.

Viewport media-query widths use the em values in `config/breakpoints.ts` (`BREAKPOINTS`). The guard checks literal media widths in CSS/SCSS/TS/TSX, including inline safety CSS, while excluding container queries and ordinary element dimensions. UI-library/Sass adapters consume the same table. Tests of namespace rules do not replace a migration-time scan for old definitions and references.

`@repo/shared` owns APP_ID and the storageKey/cookieName helpers in app-identity.ts. Web config/storage.ts derives its keys from that shared identity. Choose the application ID once when creating a project; CSS prefixes and data attributes do not change with it.
