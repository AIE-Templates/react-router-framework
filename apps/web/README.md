# Web application

React Router framework mode with shared workspace tooling, Tailwind CSS, Vitest and Testing Library. Source lives in src/app; `~/` resolves there.

Run `pnpm dev` at the workspace root for HMR at http://localhost:5173. Build with `pnpm --filter web build`. See the root README for the available commands.

## Rendering

SSR is the default. Set SSR=false for an SPA build; application route exports must be compatible. Server loaders/actions/middleware/headers (except the build-time root loader) and non-root HydrateFallback prevent SPA builds. Client data APIs can work in both modes, with a first-render skeleton followed by browser data loading.

SSR documents and Router `.data` responses carry no `Cache-Control`, as in React Router, so they are not cached by default. If the deployment adds automatic caching (for example a CDN or proxy caching HTML), configure caching for these responses to suit the application: a shared cache could otherwise serve one user's cookie-dependent content, such as session data or visual preferences, to other users. Static SPA files can be cached normally.

Use the configured start command to serve the build through react-router-serve. Run Docker builds from the workspace root.

### Development dependency optimization

`future.unstable_optimizeDeps` lets React Router supply Vite with the client entry and route modules as dependency scanning inputs. It reduces late discovery when a route first imports a dependency. It does not change production data loading or revalidation. The flag is experimental in React Router 8.5; recheck it on upgrades. If it causes dependency optimization errors, remove the flag and restart development.

Validate with a forced dependency scan in both modes (run separately, closing the first server before the second):

```sh
pnpm --filter web exec react-router dev --force --host 127.0.0.1 --port 5173 --strictPort
SSR=false pnpm --filter web exec react-router dev --force --host 127.0.0.1 --port 5173 --strictPort
```

Use an isolated browser. Check the first page hydrates, route changes and reloads work, HMR still connects, and no failed module requests or page errors appear. `--force` forces Vite dependency optimization; a warm-page reload alone does not validate cold startup. This is a development compatibility check, not a measured claim about production startup speed.

### Route discovery and revalidation

SSR keeps React Router's default lazy route discovery. It sends the initially matched route metadata and discovers other paths through `/__manifest`; rendered links normally start discovery ahead of a click. Large route tables benefit from the smaller initial manifest. For small apps with frequent programmatic navigations to new dynamic paths, consider `routeDiscovery: { mode: "initial" }` in `react-router.config.ts`. This sends all route metadata initially, while route code remains split. SPA already uses initial discovery; do not force lazy discovery there.

Compare initial document size and first visits to new dynamic paths before choosing. Manifest discovery, server-loader `.data` requests and application API calls are separate costs; changing discovery does not eliminate loader requests.

The root keeps default revalidation. A custom `shouldRevalidate` defines the freshness contract of its own loader, including explicit refreshes and mutations. Equal current/next URLs are not an explicit-refresh signal: `revalidate()` during a pending navigation targets the destination URL. If optimizing a known navigation with `defaultShouldRevalidate: false`, check every reused loader affected by that call, not just root. Keep dynamic identity and resource invalidation explicit.

## Layout

`AppRoot` provides the host environment and global providers. `BasicShell` and `NavigationShell` implement the App Shell, which frames the current app area and owns navigation between areas. `AppAreaLayout` organizes navigation, main content and optional panels within one area. The CRM demo has three pages: Leads (`/`), Deals (`/deals`) and Sales report (`/reports/sales`). With `?shell=basic`, all three share one area. In the default layout the shell switches between Sales (Leads and Deals) and Reports (Sales report). The App shell selector compares both layouts on the current page. Open `/?layout=editor` for a resizable two-column layout built directly with `WindowLayout` and `WindowColumn`. Use `?header=standalone` to try a separate title bar. Safety CSS stays inline in root Layout, outside route success/failure. It requires the default style-src unsafe-inline allowance; a stricter policy needs a hash. See docs/specs/layout.spec.md for contracts.

## Source organization

`src/app/routes.ts` maps URLs to feature route modules (`features/<name>/<page>.route.tsx`). The disposable CRM, Settings and Chat examples live in `features/demo`. To remove them, delete that directory and its registrations in `routes.ts`. `features/main` holds the SPA 404. The root document remains in `root.tsx`.

Global CSS enters through `styles/index.css`. Prefer colocated CSS Modules in the `components` cascade layer; Tailwind utilities remain available. Use `~/` for app-root imports and `./` within a directory or its children. See the root and directory-level AGENTS.md files for conventions.

Core removes starter system-color and background rules from `styles/base.css`: manual visual preferences must win over the OS preference. Core global rules now live in `styles/base.css`, `tokens.css` and `shell.css`; `styles/ui.css` imports Mantine styles and defines the app’s focus, reduced-motion and desktop drag-region overrides. Demo smoke selectors use `data-demo-controls` and `data-demo-draft`, independently of CSS class names.

## Core development

### Async result ownership

Cancellation stops unnecessary work where supported. A result also needs an owner check before it can change state, write persistent data or navigate. The owner includes the active account/workspace/resource and a sequence for operations within it. Advancing the sequence on replacement, logout or disposal invalidates old completions; an unmount check alone does not cover a still-mounted component switching resources.

For example, a lifecycle-owned reader can combine cancellation with a sequence:

```ts
let generation = 0;
let active: AbortController | undefined;

function invalidate() {
  ++generation;
  active?.abort();
  active = undefined;
}

async function refresh(resourceId: string) {
  invalidate();
  const mine = generation;
  const controller = new AbortController();
  active = controller;
  try {
    const value = await readResource(resourceId, controller.signal);
    if (mine !== generation || controller.signal.aborted) return;
    publish(value);
  } catch (error) {
    if (mine !== generation || controller.signal.aborted) return;
    publishError(error);
  } finally {
    if (mine === generation) active = undefined;
  }
}
```

Here `readResource`, `publish` and `publishError` belong to the consumer. Keep these variables inside its lifecycle/controller, not an SSR module singleton. Call `invalidate()` on owner changes and disposal, before clearing owned caches. Recheck after each later await; a check before an asynchronous database open is not sufficient to guard the eventual write. Persistent writes already started need ordering/transaction handling, and aborting a request does not undo a server mutation. Before navigating after a mutation, also check the initiating resource/path and whether a newer navigation is pending.

Extend existing owners when adding data features; no generic cache or account manager is required. Test old-success/new-success and old-failure/new-success ordering with deferred promises, plus disposal or identity replacement while work is pending.

### Shared components

Read environment through `~/managers/environment/hooks`; read window facts from its `chrome` field. Independent layouts mount `ChromeAdapterProvider` and read `useChromeSnapshot()` for shell and chrome or `useChromeState()` for chrome alone. Drag and interactive props live in `~/platform/chrome-adapter/dom-props`. Reuse `~/components/appearance-settings` for appearance UI. Ordinary component tests may use `renderWithProviders` from `~/testing/render`; route-dependent components still need an explicit Router context, and provider lifecycle tests can mount providers directly.

Colors use Core semantic variables; viewport media widths come from `~/config/breakpoints`. CSS Modules use the components layer. `tests/architecture/styles.test.ts` checks real CSS/SCSS and TS/TSX source, including inline CSS strings. The window safety stylesheet stays inline and unlayered in `layouts/app-shell/chrome-safety.ts`.

Custom layouts read `--app-window-safe-top`, `--app-window-safe-left` and `--app-window-safe-right` for native control clearance. The document reserves the top inset by default. To lay out edge to edge, put `data-window-safe-area-owner=""` on the visible element responsible for clearance. Mark drag surfaces with `getDragRegionProps()` and pointer targets with `getInteractiveProps()`. Removing or hiding the owner restores the document reservation. The geometry remains available in either mode.

## Mantine UI

`AppUiProvider` composes the Mantine providers. Extend the adapters in `src/app/managers/visual/mantine` to map application tokens to component themes. The appearance panel in `src/app/components/appearance-settings.tsx` demonstrates Select, Button and portalled surfaces.

Mantine’s `setColorScheme` skips writes when the effective preference already matches. Use the VisualManager action `setColorSchemePreference` when an explicit choice should survive a future change to the product default. See the [Mantine integration spec](../../docs/specs/mantine.spec.md).
