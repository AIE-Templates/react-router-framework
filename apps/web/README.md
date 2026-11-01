# Web application

React Router framework mode with shared workspace tooling, Tailwind CSS, Vitest and Testing Library. Source lives in src/app; `~/` resolves there.

Run `pnpm dev` at the workspace root for HMR at http://localhost:5173. Build with `pnpm --filter web build`. See the root README for the available commands.

## Rendering

SSR is the default. Set SSR=false for an SPA build; application route exports must be compatible. Server loaders/actions/middleware/headers (except the build-time root loader) and non-root HydrateFallback prevent SPA builds. Client data APIs can work in both modes, with a first-render skeleton followed by browser data loading.

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

For separate static/client hosting, build with VITE_API_ORIGIN and list the client origin in the server's ALLOWED_ORIGINS for credentialed requests. Server redirects are relative; an embedded host's internal request URL is not a public origin.

## Host identity

The entry supplies createWebApp({ shell }); requests cannot select identity. Trusted desktop request data is distinct from stable shell facts. Web strips X-Desktop-* before Router; desktop accepts injected state. WEB_SHELL* is development-only; builds retain the web seed. Components use useAppEnvironment; document attributes mirror it. SSR seeds hydration, then valid preload bootstrap supplies runtime identity; later root revalidation cannot overwrite it.

## Layout

AppRoot owns environment/providers; BasicShell or NavigationShell owns application framing; ModuleLayout owns its workspace/panels. The home route demonstrates ?shell=basic and ?header=standalone. Safety CSS stays inline in root Layout, outside route success/failure. It requires the default style-src unsafe-inline allowance; a stricter policy needs a hash. See docs/specs/layout.spec.md for contracts.

## Source organization

`src/app/routes.ts` maps URLs to feature route modules (`features/<name>/<page>.route.tsx`). The disposable home example lives in `features/demo`; removing its route registration and directory removes `/`. `features/main` holds the SPA 404. The root document remains in `root.tsx`.

Global CSS enters through `styles/index.css`. Prefer colocated CSS Modules in the `components` cascade layer; Tailwind utilities remain available. Use `~/` for app-root imports and `./` within a directory or its children. See the root and directory-level AGENTS.md files for conventions.

Core removes starter system-color and background rules from `styles/base.css`: manual visual preferences must win over the OS preference. Core global rules now live in `styles/base.css`, `tokens.css` and `shell.css`; the empty `ui.css` is the UI-library integration slot. `app.css` is retained only as the downstream migration bridge until final cleanup. Demo smoke selectors use `data-demo-controls` and `data-demo-draft`, independently of CSS class names.

## Core development

Read environment through `~/managers/environment/hooks`; interactive and drag DOM props come from `~/managers/environment/dom-props`. The runtime is still created by AppRoot. Reuse `~/components/appearance-settings` for appearance UI. Ordinary component tests may use `renderWithProviders` from `~/testing/render`; route-dependent components still need an explicit Router context, and provider lifecycle tests can mount providers directly.

Colors use Core semantic variables; viewport media widths come from `~/config/breakpoints`. CSS Modules use the components layer. `styles/naming.test.ts` checks real CSS/SCSS and TS/TSX source, including inline CSS strings. The window safety stylesheet stays inline and unlayered in `layouts/app-shell/chrome-safety.ts`.

## Host integration tests

`src/host/api.integration.test.ts` exercises the real in-process BFF; the fake-client component test remains beside `src/app/lib/api.ts`. `src/host/root.integration.test.tsx` exercises the actual root loader and CSP nonce handoff. Host tests explicitly select Node or jsdom and import application code through `~/`; generated route argument types are inferred from the exported function. Pure component tests remain colocated.

The fullstack Core host root suite also verifies web document attributes and hydration. The no-loader safety/bootstrap fallback test stays beside `root.tsx`. Visual cookie names come from `cookieName("visual")` in `@repo/shared`; the build-time `VITE_VISUAL_COOKIE=true` opt-in and cookie lifetime remain unchanged.

## Electron adapters

Electron-specific host contexts and preference helpers live in `~/platform/electron/shell` and `~/platform/electron/preferences`; visual synchronization remains beside them. Features may consume the preference API without implementing host branches. Application code never imports `src/host`; host integration can import the adapters through `~/`.

`src/host/desktop-root.integration.test.tsx` covers Electron root host facts with an explicit jsdom environment and real host context. The pure safety/bootstrap fallback rendering test remains beside `root.tsx`.

Preference cookie names use `PREFERENCE_COOKIE_PREFIX` from `@repo/shared`, derived with `cookieName("pref_")`; the default prefix is `framework-app_pref_`. Parsing and byte limits use that same constant. Old `pref-*` cookies are ignored and may reset to defaults; no compatibility layer is provided for the template. Visual storage and visual cookie derived names remain unchanged.
