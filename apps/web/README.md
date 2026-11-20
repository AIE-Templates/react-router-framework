# Web application

React Router framework mode with shared workspace tooling, Tailwind CSS, Vitest and Testing Library. Source lives in src/app; `~/` resolves there.

Run `pnpm dev` at the workspace root for HMR at http://localhost:5173. Build with `pnpm --filter web build`. See the root README for the available commands.

## Rendering

SSR is the default. Set SSR=false for an SPA build; application route exports must be compatible. Server loaders/actions/middleware/headers (except the build-time root loader) and non-root HydrateFallback prevent SPA builds. Client data APIs can work in both modes, with a first-render skeleton followed by browser data loading.

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

## Host and API

Hono runs pages and @repo/server in the same process. src/host/app.ts composes createHostApp; web-app.ts adds static files and SPA fallback as createWebApp; vite-plugin.ts adapts development/prerendering; testing.ts provides createTestContext. server.ts is only the native Node production entry. API lives under /api.

Loaders/actions call context.get(apiContext); browser/client data APIs use api from ~/lib/api. Import only server types through @repo/server/types in application/browser code. In-process calls forward credentials, request ID and AbortSignal; pass the signal to upstream fetches. Mutations belong in actions because in-process API calls bypass CSRF. Deferred loader promises use logRejection with loggerContext and request.signal. Integrated tests use createTestContext; route components may use createRoutesStub.

Each request passes through one logging/error/request-ID chain. Use context.get(loggerContext) or c.var.logger. Stream timing is time to first byte; expected 4xx and caller cancellation are not unhandled errors. Cross-origin action rejection logs a bounded warning. Production defaults apply when NODE_ENV is absent.

## CSP

SSR has one per-document nonce shared by ServerRouter, React streaming, Links, ScrollRestoration and Scripts. Both hydration sides use the same nonce prop. Root revalidation must not replace the active document nonce; root error rendering recovers it from the document. Static SPA/prerendered documents use content hashes for inline scripts; GET/HEAD policies match and document ranges are disabled. Production script-src excludes unsafe-inline. Development permits Vite/HMR using its own policy. Configure csp in createWebApp/createHostApp, or false to disable it deliberately. Add cross-origin API destinations to connect-src.

## Environment and deployment

Copy .env.example for local configuration. Router config loads it for dev/build; server.ts loads it for start. Existing variables take priority and ${VAR} expansion is supported. Restart dev after edits. Only VITE_* enters browser bundles; native server code uses process.env. HOST/PORT default to 0.0.0.0/3000, LOG_LEVEL to debug in development and warn in production. Enable TRUST_PROXY only behind a trusted TLS-terminating proxy supplying forwarded protocol/host.

Run pnpm build then node apps/web/server.ts, or the configured start script. Deploy build, server.ts, package.json and production dependencies with pnpm deploy. Start Node directly in production to receive signals. The host chooses SSR/SPA from the built server export, not runtime SSR configuration. Static assets are cached/compressed; documents and API are left to the proxy/CDN for compression so streaming HTML is not buffered. Prerendered HTML/data revalidate; SPA deep links use __spa-fallback.html when present, otherwise index.html.

createWebApp returns a Hono app with standard Request/Response fetch semantics for embedding. clientDir can locate external static resources. External React, Router, Hono, node adapter and pino versions must match the web package. Heavy SSR shares the host event loop; use a worker/utility process when isolation is needed. Build Docker from the workspace root using apps/web/Dockerfile; the deployed Node process runs as a nonprivileged user.

For separate static/client hosting, build with VITE_API_ORIGIN (Docker accepts `--build-arg VITE_API_ORIGIN=https://api.example.com`) and list the client origin in the server's ALLOWED_ORIGINS for credentialed requests. Server redirects are relative; an embedded host's internal request URL is not a public origin.

## Host identity

This template serves the Web application with `createWebApp()`. Components read the Web environment through `useAppEnvironment()`.

## Layout

AppRoot owns environment/providers; BasicShell or NavigationShell owns application framing; ModuleLayout owns its workspace/panels. The home route demonstrates ?shell=basic and ?header=standalone. Safety CSS stays inline in root Layout, outside route success/failure. It requires the default style-src unsafe-inline allowance; a stricter policy needs a hash. See docs/specs/layout.spec.md for contracts.

## Source organization

`src/app/routes.ts` maps URLs to feature route modules (`features/<name>/<page>.route.tsx`). The disposable Home, Settings and Chat examples live in `features/demo`. To remove them, delete that directory and its three route registrations (`/`, `/settings` and `/chat`). `features/main` holds the SPA 404. The root document remains in `root.tsx`.

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

Read environment through `~/managers/environment/hooks`; interactive and drag DOM props come from `~/managers/environment/dom-props`. The runtime is still created by AppRoot. Reuse `~/components/appearance-settings` for appearance UI. Ordinary component tests may use `renderWithProviders` from `~/testing/render`; route-dependent components still need an explicit Router context, and provider lifecycle tests can mount providers directly.

Colors use Core semantic variables; viewport media widths come from `~/config/breakpoints`. CSS Modules use the components layer. `tests/architecture/styles.test.ts` checks real CSS/SCSS and TS/TSX source, including inline CSS strings. The window safety stylesheet stays inline and unlayered in `layouts/app-shell/chrome-safety.ts`.

## Host integration tests

`src/host/api.integration.test.ts` exercises the real in-process BFF; the fake-client component test remains beside `src/app/lib/api.ts`. `src/host/root.integration.test.tsx` exercises the actual root loader and CSP nonce handoff. Host tests explicitly select Node or jsdom and import application code through `~/`; generated route argument types are inferred from the exported function. Pure component tests remain colocated.

The fullstack Core host root suite also verifies web document attributes and hydration. The no-loader safety/bootstrap fallback test stays beside `root.tsx`. Visual cookie names come from `cookieName("visual")` in `@repo/shared`; enable the cookie mirror at build time with `VITE_VISUAL_COOKIE=true` or `docker build --build-arg VITE_VISUAL_COOKIE=true -f apps/web/Dockerfile .`.

## Mantine UI

`AppUiProvider` composes the Mantine providers. Extend the adapters in `src/app/managers/visual/mantine` to map application tokens to component themes. The appearance panel in `src/app/components/appearance-settings.tsx` demonstrates Select, Button and portalled surfaces.
