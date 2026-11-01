# Contributor instructions

## Workspace

Use pnpm and the Node version declared in package.json. Shared TypeScript, Oxlint, Oxfmt, Vitest, Lefthook and commitlint configuration lives at the workspace root. Run workspace commands there. React Router application source is apps/web/src/app, imported with `~/`; native Node entry/config files and public assets remain at the app root.

Before changing Router routes, loaders, actions or integration, read `.agents/skills/react-router/SKILL.md`, its framework-mode reference and the matching installed Router documentation.

## Checks and tests

After changes run `pnpm lint:fix`, then `pnpm fmt`. Before completion run `pnpm exec oxlint --deny-warnings --format=agent`, `pnpm typecheck` and `pnpm test` (use `pnpm exec vitest run` for a finite run).

Unit tests use Vitest and Testing Library, colocated as *.test.ts(x). Each package has a Vitest project. Use createRoutesStub when components need Router context; invoke loaders/actions directly. Keep environment examples synchronized with new variables, document purpose/defaults and never commit .env files.

## Commits

Use Conventional Commits, checked by @commitlint/config-conventional. Lefthook runs Oxlint/Oxfmt on staged files. Do not bypass hooks with --no-verify.

## Directory structure

Business routes and UI live in features/<name>. Route modules use <page>.route.tsx and layout routes use <name>.layout.tsx; routes.ts is the only URL-to-file map. Generated route types use ./+types/<page>.route. features/main holds application layout routes and the SPA 404; features/demo is a disposable sandbox and must not be imported by other directories. Removing demo and its route registration removes the template home page.

Use ~/ for app-root imports; ./ may reference the same directory or its children. Parent-relative imports are forbidden by lint within apps/*/src/**. Package internals, build configuration, scripts and e2e files are outside this scoped rule. Cross-package imports use workspace package names. Features do not import one another. Keep reusable UI, hooks and pure helpers outside features when shared. Do not add barrel index.ts files under src/app. Colocate tests with their source; host-dependent integration tests belong to src/host when that layer exists. Create directories only when needed.

## Styling

Default to colocated CSS Modules named after the component, imported as classes with camelCase class names. Put module rules in @layer components so Tailwind utilities can override them; Tailwind remains optional and supported. Global stylesheet imports enter through styles/index.css, with layer order theme, base, mantine, components, utilities. Never use light-dark() or bare rem() in project styles.

## Naming

Use kebab-case file and directory names, PascalCase component exports and useXxx hooks in use-xxx.ts files. Application CSS variables use --app-; reserve --app-shell-* for Mantine. Feature-local variables use --<feature>- on the feature root, never :root. Tailwind theme and third-party variables retain their own names. Data attributes use domain-name without an application prefix.

## Rendering

SSR is the default; SSR=false at dev/build selects SPA.

SPA builds reject non-root server loaders, server actions/middleware/headers and non-root HydrateFallback. The root loader runs at build time. Components, meta, links, ErrorBoundary and client data APIs can support both modes. Select rendering requirements deliberately rather than assuming every application can switch unchanged.

## Application infrastructure

Compose global providers in AppRoot. Components read useAppEnvironment from ~/managers/environment/hooks; never infer host identity from user agents, query parameters or data-shell. Do not call the bridge during rendering. Root loader data seeds hydration; confirmed preload identity survives revalidation.

Pages compose BasicShell or NavigationShell with ModuleLayout. Modules do not handle OS branches, native control geometry or window IPC. Mark top interactive elements with getInteractiveProps and drag regions with getDragRegionProps. Inline CHROME_SAFETY_CSS and retain .root-chrome-fallback outside route children for normal, fallback and error documents. Safety geometry cannot depend on provider/bootstrap readiness. CHROME_SAFETY_CSS remains inline and unlayered; the global stylesheet entry rule does not move it into styles/. Environment runtime/context/hooks/dom-props live in managers/environment. AppRoot creates the environment runtime directly; it is not a ManagersRegistry member. The reusable appearance panel lives in components/appearance-settings.tsx.

The dependency direction is a convention, not a lint-enforced graph. Production features use shared components/layouts/hooks, then managers/services, then lib/utils/config. Providers are composition points used by root/entry.server; testing/render.tsx composes them for ordinary UI tests. Specialized provider/lifecycle tests may mount providers directly. New resource APIs belong in services/ when needed; no Core ApiClient is introduced.

@repo/shared must remain browser-importable with no node: imports or runtime dependencies. Resolve source through @repo/source in workspace Vite, Vitest and TypeScript configuration; new consumers need the same condition.

## Server and host

Host-dependent integration tests live under apps/web/src/host with an explicit node/jsdom environment. Preserve real BFF and load-context calls; colocated application tests cover pure components or fake clients. Host tests import application modules via ~/ and derive route argument types from exported functions instead of aliasing generated +types.

packages/server is Hono, independently runnable under native Node and also hosted in-process. Use explicit .ts relative imports and erasable TypeScript; no enums, namespaces, parameter properties, import.meta.env or React Router dependency. Development-only behavior checks NODE_ENV === "development"; unset means production.

Keep host logic in apps/web/src/host. app.ts composes createServerApp with Router; web-app.ts adds static/SPA handling as createWebApp. server.ts only loads environment/build and starts production. getHostApp serves dev/prerender through the Vite adapter. Load .env only in react-router.config.ts and server.ts. Preserve dotenv 17.x/dotenv-expand 13.x; command substitution in newer expand versions needs review.

Keep source/dist export targets synchronized. Workspace imports use @repo/source. All packages use the same Hono version. API route chains live in packages/server/src/routes and mount under /api; unknown API routes return JSON 404. Browser/app imports from server are type-only via @repo/server/types; host/tests may import implementations.

Loaders/actions call context.get(apiContext) in-process; browser/client loaders use ~/lib/api. In-process calls forward request credentials, ID and cancellation, bypassing API CSRF. Put mutations in actions, never loaders; Router performs action origin checks. Native clients send JSON or matching Origin. Only trust forwarded headers behind a trusted proxy.

Pass request.signal to upstream fetch. Use createTestContext or a fake apiContext for loader tests and Hono testClient for API routes. Wrap deferred promises in logRejection with the request logger and signal; Router handleError does not capture these rejections. Hono stream/streamText/streamSSE callbacks use rethrowNonErrors and logStreamFailure. Log structured data first through c.var.logger or loggerContext, never console, credentials or full query strings.

Middleware extends the same host/server chain before Router fallback; do not wrap it in a second Hono app. Keep entry.server.tsx aligned with Router's default Node entry during upgrades. CSP uses one SSR document nonce for ServerRouter, React, Links, ScrollRestoration and Scripts; preserve it across revalidation. Static HTML uses sha256 hashes. Production script-src excludes unsafe-inline; configure additional resource origins explicitly.

In-process server data APIs provide SSR data and cookie forwarding but prevent SPA builds. Client data APIs support either build mode with a first-render skeleton and a browser request. Moving SSR server-data routes to SPA requires rewriting them.

## Desktop

Electron-specific web adapters live in apps/web/src/app/platform/electron: shell.ts owns host contexts, preferences.ts exposes display preference helpers, and desktop-visual-sync.tsx bridges visual state. Import them via ~/platform/electron. Host-dependent Electron root tests live in src/host/desktop-root.integration.test.tsx; keep pure fallback rendering tests beside root.tsx. Core remains free of host protocol implementation.

In apps/desktop, ~/ resolves to src through TypeScript and Vite/Vitest. Application code uses ~/ instead of parent-relative imports. Native Node scripts/ and e2e/ may use standalone import type from ~/; value imports and inline import { type X } are not safe because Node does not resolve the alias. Cross-boundary runtime code uses workspace packages, never relative imports into another app or package source.

Choose APP_ID in @repo/shared and productName in apps/desktop/package.json when creating a project. Keep electron-builder.yml productName identical; appId is the separate package identity and does not determine userData. Packaged E2E uses productName for macOS/Windows and lowercased package name for Linux; preserve the portable-name validation and unsupported executableName override guard. Existing visual localStorage/cookie names retain their derived values; old pref-* cookies are intentionally ignored without a compatibility layer.

apps/desktop uses Vite bundles and electron-builder. Main/preload are CommonJS; utility is ESM and runs createWebApp via port-fetch. Main must not import @repo/server or top-level await app.whenReady. Capture uncaught exceptions through logging, not blocking Electron default dialogs. Validate each IPC with isTrustedSender. Keep dependencies empty except required external native modules; bundle other dependencies.

Main maps app://app to the internal HTTP origin, injects trustworthy non-GET Origin and desktop state, and maps redirects back. Host identity comes only from entry configuration, never requests. Strip untrusted desktop headers; only a desktop entry trusts main-supplied values. Server redirects stay relative; request.url is not a public URL. Static files belong solely to the web host. Utility compile cache is in userData.

Port-fetch and channel must remain Electron-independent. Test with worker_threads MessageChannel and local ws. Port-fetch sends standalone Uint8Array chunks via structured cloning; do not use ArrayBuffer transfer lists with Electron MessagePortMain or assume zero-copy. Propagate cancellation through request.signal. Channel producers await whenDrained; send neither blocks nor drops. Relay preserves ordering/backpressure/close semantics; use shared CLOSE_CODES.

Desktop page document.cookie is unavailable. Main manages server cookies in the dedicated session and sends them only to the app upstream. Client-readable state uses loader data, localStorage or explicit helpers. Visual preferences use VisualManager; the Electron theme mirror uses its dedicated IPC and visual-theme.json. Other small display preferences use getPreference/useSetPreference/writePreference, never shell-specific business branches or direct cookie writes. Desktop persists prefs.json and injects x-desktop-prefs; web derives preference cookie names from PREFERENCE_COOKIE_PREFIX = cookieName("pref_") in @repo/shared. Both enforce shared key/size limits. Preferences are user-controlled and must never authorize access or store credentials.

Run build:desktop, DESKTOP_SMOKE=1 DESKTOP_BOOT_PROFILE=1 with desktop start, and check packaged artifacts (desktop package for test-profile; package:release changes Fuses). Desktop E2E uses Playwright with isolated userData and closes all launched processes. Build/package before both E2E targets; unpackaged needs only build. Test endpoints require DESKTOP_E2E=1 and never mount in release-profile. Release cannot be driven with the inspector-based test driver. Compare repeated boot-profile medians for startup changes. Specs live in docs/specs; decisions in docs/adrs.

Inline CHROME_SAFETY_CSS relies on the default CSP style-src unsafe-inline allowance; add a hash before tightening it.

## Visual state

VisualManager owns preferences, storage and system resolution. Use useVisualState/useVisualActions; do not write its storage key directly. Registry components only compose providers. Keep the serialized visualKernel self-contained: production prepaint execution is tested separately from module execution. AppUiProvider is the body UI integration slot; never put style-producing providers around html. Keep server and client snapshots separate and do not overwrite prepaint attributes with hydration defaults.

Application identity is defined once in @repo/shared app-identity.ts. Choose APP_ID when creating a project; config/storage.ts derives keys through storageKey(). Color tokens use --app-color-* and are the source for Tailwind aliases and UI-library adapters. BREAKPOINTS in config/breakpoints.ts owns viewport media-query widths in em. CSS naming and media-query source guards run with the Web tests; reviewed exceptions require a same-line naming-allow: reason comment.

## UI library

Mantine adapters derive both palettes from Core semantic tokens in managers/visual/mantine/theme.ts. Keep typography, radius and breakpoints tied to app config; dynamic prepaint fallback uses the same resolved theme and resolver. Global Mantine imports, focus ring, reduced-motion and no-drag rules belong in styles/ui.css. Preserve native-control selectors that exclude Mantine classes.

Use CSS Modules for Core components; do not convert inherited modules just to use Sass. Mantine-specific SCSS may use the injected mantine namespace: mantine.rem() preserves --mantine-scale, breakpoint mixins use config/breakpoints.ts, hover handles pointer capabilities, and rtl is only for cases logical properties cannot express. Colors use semantic variables, never color-scheme mixins or light-dark(). The _mantine.scss tool module emits no CSS and is injected once per compilation by the shared Vite/Vitest CSS configuration; do not @use or @forward it again. Global styles remain CSS. Build integration tests compile temporary fixtures through the actual Sass and PostCSS pipeline and clean them up.
