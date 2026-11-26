# Contributor instructions

## Workspace

Use pnpm and the Node version declared in package.json. Shared TypeScript, Oxlint, Oxfmt, Vitest, Lefthook and commitlint configuration lives at the workspace root. Run workspace commands there. React Router application source is apps/web/src/app, imported with `~/`; native Node entry/config files and public assets remain at the app root.

Before changing Router routes, loaders, actions or integration, read `.agents/skills/react-router/SKILL.md`, its framework-mode reference and the matching installed Router documentation.

## Checks and tests

After changes run `pnpm lint:fix`, then `pnpm fmt`. Before completion run `pnpm exec oxlint --deny-warnings --format=agent`, `pnpm typecheck` and `pnpm test` (use `pnpm exec vitest run` for a finite run).

Unit tests use Vitest and Testing Library, colocated as *.test.ts(x). Each package has a Vitest project. Use createRoutesStub when components need Router context; invoke loaders/actions directly. Keep environment examples synchronized with new variables, document purpose/defaults and never commit .env files.

Inject failures at a narrow external boundary in isolated tests, preserve the real component/provider path, and assert recovery after removing the fault as well as the failure state. Restore injections in finally; use deterministic gates instead of fixed sleeps for races.

## Commits

Use Conventional Commits, checked by @commitlint/config-conventional. Lefthook runs Oxlint/Oxfmt on staged files. Do not bypass hooks with --no-verify.

## Directory structure

Business routes and UI live in features/<name>. Route modules use <page>.route.tsx and layout routes use <name>.layout.tsx; routes.ts is the only URL-to-file map. Generated route types use ./+types/<page>.route. features/main holds application layout routes and the SPA 404; features/demo is a disposable sandbox and must not be imported by other directories. Remove the demo directory and all its registrations in routes.ts together.

Use ~/ for app-root imports; ./ may reference the same directory or its children. Parent-relative imports are forbidden by lint within apps/*/src/**. Package internals, build configuration, scripts and e2e files are outside this scoped rule. Cross-package imports use workspace package names. Features do not import one another. Keep reusable UI, hooks and pure helpers outside features when shared. Do not add barrel index.ts files under src/app. Colocate tests with their source; host-dependent integration tests belong to src/host when that layer exists. Create directories only when needed.

## Styling

Default to colocated CSS Modules named after the component, imported as classes with camelCase class names. Put module rules in @layer components so Tailwind utilities can override them; Tailwind remains optional and supported. Global stylesheet imports enter through styles/index.css, with layer order theme, base, mantine, components, utilities. Never use light-dark() or bare rem() in project styles.

## Naming

Use kebab-case file and directory names, PascalCase component exports and useXxx hooks in use-xxx.ts files. Application CSS variables use --app-; reserve --app-shell-* for Mantine. Feature-local variables use --<feature>- on the feature root, never :root. Tailwind theme and third-party variables retain their own names. Data attributes use domain-name without an application prefix.

## Rendering

SSR is the default; SSR=false at dev/build selects SPA.

SPA builds reject non-root server loaders, server actions/middleware/headers and non-root HydrateFallback. The root loader runs at build time. Components, meta, links, ErrorBoundary and client data APIs can support both modes. Select rendering requirements deliberately rather than assuming every application can switch unchanged.

Keep default root revalidation. Optimize only after checking loader dependencies and explicit invalidation; an in-flight navigation can have different current/next URLs even during revalidate(). See apps/web/README.md for dependency optimization, route discovery and revalidation guidance.

## Application infrastructure

Async results belong to the resource, identity and operation that started them. Propagate cancellation and recheck ownership after awaits before publishing state, writing a cache or navigating. Invalidate old owners before clearing caches; checking only whether a component is mounted is insufficient. Do not suppress errors from the current owner. See the async ownership example in apps/web/README.md; reuse existing lifecycle guards before adding abstractions.

Compose global providers in AppRoot. Components read useAppEnvironment from ~/managers/environment/hooks; never infer host identity from user agents, query parameters or data-shell. Do not call the bridge during rendering. Root loader data seeds hydration; confirmed preload identity survives revalidation.

Choose app areas from the page layout. The same routes and features can share one area or span several. BasicShell frames one area; NavigationShell also hosts the area switcher. Implement each area's layout to suit the product. For fused headers, render WindowLayout inside the shell and put each header and its content in a WindowColumn. Mark one visible column primary. AppAreaLayout uses these primitives for the CRM demo. For a custom layout with a separate title bar, use the shell's standalone header mode. Keep native control geometry and window IPC in the shell and host integration. See docs/specs/layout.spec.md for the fused header contract.

Mark top interactive elements with getInteractiveProps and drag regions with getDragRegionProps. Inline CHROME_SAFETY_CSS and retain .root-chrome-fallback outside route children for normal, fallback and error documents. Safety geometry cannot depend on provider/bootstrap readiness. CHROME_SAFETY_CSS remains inline and unlayered; the global stylesheet entry rule does not move it into styles/. Environment runtime/context/hooks/dom-props live in managers/environment. AppRoot creates the environment runtime directly; it is not a ManagersRegistry member. The reusable appearance panel lives in components/appearance-settings.tsx.

Layer ordering remains a convention; architecture tests enforce the app/host, feature and test boundaries. Production features use shared components/layouts/hooks, then managers/services, then lib/utils/config. Providers are composition points used by root/entry.server; testing/render.tsx composes them for ordinary UI tests. Specialized provider/lifecycle tests may mount providers directly. New resource APIs belong in services/ when needed; no Core ApiClient is introduced.

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

Electron-specific web adapters live in apps/web/src/app/platform/electron: shell.ts owns host contexts, preferences.ts exposes display preference helpers, and visual-prepaint.ts reads the fixed window appearance. Import them via ~/platform/electron. Host-dependent Electron root tests live in src/host/desktop-root.integration.test.tsx; keep pure fallback rendering tests beside root.tsx. Core remains free of host protocol implementation.

In apps/desktop, ~/ resolves to src through TypeScript and Vite/Vitest. Application code uses ~/ instead of parent-relative imports. Native Node scripts/ and e2e/ may use standalone import type from ~/; value imports and inline import { type X } are not safe because Node does not resolve the alias. Cross-boundary runtime code uses workspace packages, never relative imports into another app or package source.

Choose APP_ID in @repo/shared and productName in apps/desktop/package.json when creating a project. Keep the productName in electron-builder.base.yml identical; appId is the separate package identity and does not determine userData. Packaged E2E uses productName for macOS/Windows and lowercased package name for Linux; preserve the portable-name validation and unsupported executableName override guard. Existing visual localStorage/cookie names retain their derived values; old pref-* cookies are intentionally ignored without a compatibility layer.

apps/desktop uses Vite bundles and electron-builder. Main/preload are CommonJS; utility is ESM and runs createWebApp via port-fetch. Main must not import @repo/server or top-level await app.whenReady. Capture uncaught exceptions through logging, not blocking Electron default dialogs. Validate desktop capability IPC with isTrustedSender. Frame cookie IPC checks registered window and session ownership and senderFrame.origin. Keep dependencies empty except required external native modules; bundle other dependencies.

Install the default-deny permission policy immediately after creating the application session. Keep request/check decisions aligned; only verified application main frames receive explicitly allowed capabilities, and device access is denied. External sub-frame navigation and redirects must not launch the system browser. Production build commands normalize Web and desktop build environments; test and release bundles and the utility use production NODE_ENV. Only dev:desktop builds the dev profile, in watch mode.

Keep the stable application scheme/host/origin and URL check in apps/desktop/src/main/app-url.ts. Do not derive this storage origin from a product rename or APP_ID. Main maps app://app to the internal HTTP origin, injects trustworthy non-GET Origin and desktop state, and maps redirects back. Host identity comes only from entry configuration, never requests. Strip untrusted desktop headers; only a desktop entry trusts main-supplied values. Server redirects stay relative; request.url is not a public URL. Static files belong solely to the web host. Utility compile cache is in userData.

Port-fetch and channel must remain Electron-independent. Test with worker_threads MessageChannel and local ws. Port-fetch sends standalone Uint8Array chunks via structured cloning; do not use ArrayBuffer transfer lists with Electron MessagePortMain or assume zero-copy. Propagate cancellation through request.signal. Channel producers await whenDrained; send neither blocks nor drops. Relay preserves ordering/backpressure/close semantics; use shared CLOSE_CODES.

Application scripts can read and write non-HttpOnly cookies. Main sends jar cookies only to the app upstream. Other custom schemes do not participate. Keep @repo/electron-cookies self-contained for later extraction, with no @repo/* imports or application code. Wire it through host configuration and callbacks.

Visual preferences use VisualManager. Each window’s App Shell owns its overlay override. Other small display preferences use getPreference/useSetPreference/writePreference, never shell-specific business branches or direct cookie writes. Desktop persists prefs.json and injects x-desktop-prefs; web derives preference cookie names from PREFERENCE_COOKIE_PREFIX = cookieName("pref_") in @repo/shared. Both enforce shared key/size limits. Preferences are user-controlled and must never authorize access or store credentials. Preference writes must still refresh loaders, including during navigation. See apps/web/README.md for the preference integration test.

Build profiles (dev, test, release) are fixed at build time; HOST-11 in docs/specs/electron-shell.spec.md is the contract and rationale for what differs. Never add a runtime check that enables test or debug behavior in release: put the capability behind a PROFILE_ENTRIES module in scripts/build-profile.ts, read debug variables only in src/debug-env.ts with names from src/debug-env.names.ts, and extend the verify:build markers. Keep the fuse table in scripts/fuses.ts the single source for both packages.

Run build:desktop:test, DESKTOP_SMOKE=1 DESKTOP_SMOKE_LAYOUT=1 DESKTOP_BOOT_PROFILE=1 with desktop start:test (add --packaged after package:desktop:test), desktop test:e2e, verify:build and verify:release. Start every test launch from scripts/launch.ts: launchSpec() for the command, switches and environment, a fresh directory from freshUserDataDir(), checkLaunchInputs() for the fuse read-back or web build check, and verifyBuildProfile() (or the Playwright fixture's evaluation) for the reported profile. Use start:desktop for manual release launches and verify:release for automated release verification; treat its exit 2 (incomplete) as not verified. Playwright has not been observed to report an unresponsive renderer (measured); check hangs without it. Run E2E and verify:release on an unlocked macOS screen. Compare repeated boot-profile medians for startup changes. Specs live in docs/specs.

Inline CHROME_SAFETY_CSS relies on the default CSP style-src unsafe-inline allowance; add a hash before tightening it.

## Visual state

VisualManager owns preferences, storage and system resolution. Use useVisualState/useVisualActions; do not write its storage key directly. Registry components only compose providers. Keep sparse choices and stamped records separate from build-time VISUAL_DEFAULTS in @repo/shared. Use visualRecordKernel.effective(snapshot) for control values and snapshot.resolved for display. Keep the shared record factory and visualKernel self-contained for production prepaint. Only connect or user commands may access live storage and bridges. AppUiProvider is the body UI integration slot; never put style-producing providers around html. Keep server and client snapshots separate and do not overwrite prepaint attributes with hydration defaults.

Application identity is defined once in @repo/shared app-identity.ts. Choose APP_ID when creating a project; config/storage.ts derives keys through storageKey(). Color tokens use --app-color-* and are the source for Tailwind aliases and UI-library adapters. BREAKPOINTS in config/breakpoints.ts owns viewport media-query widths in em. CSS naming and media-query source guards run with the Web tests; reviewed exceptions require a same-line naming-allow: reason comment.

## UI library

Mantine adapters derive both palettes from Core semantic tokens in managers/visual/mantine/theme.ts. Keep typography, radius and breakpoints tied to app config; dynamic prepaint fallback uses the same resolved theme and resolver. Global Mantine imports, focus ring, reduced-motion and no-drag rules belong in styles/ui.css. Keep native-control styling scoped to explicitly owned controls; appearance-settings uses Mantine controls and only owns its fieldset layout.

Use CSS Modules for Core components; do not convert inherited modules just to use Sass. Mantine-specific SCSS may use the injected mantine namespace: mantine.rem() preserves --mantine-scale, breakpoint mixins use config/breakpoints.ts, hover handles pointer capabilities, and rtl is only for cases logical properties cannot express. Colors use semantic variables, never color-scheme mixins or light-dark(). The _mantine.scss tool module emits no CSS and is injected once per compilation by the shared Vite/Vitest CSS configuration; do not @use or @forward it again. Global styles remain CSS. Build integration tests compile temporary fixtures through the actual Sass and PostCSS pipeline and clean them up.

## Desktop diagnostic organization

The demo storage-failure E2E illustrates this without adding production test switches. See apps/desktop/README.md.

Keep host E2E independent of demo text and controls. Tag demo-specific tests with @demo; test:e2e includes them for template acceptance, while test:e2e:host remains usable after replacing the demo. Preserve IndexedDB transaction-completion and restart coverage.

Keep diagnostic runners/routes under apps/desktop/src/diagnostics/{smoke,bench,e2e}; main/ contains application runtime services. Process entries reach diagnostics only through ~/diagnostics/entry.ts, imported by exactly that specifier so release builds can replace it; keep entry.contract.ts and entry.empty.ts in step. DESKTOP_SMOKE selects the application suite; DESKTOP_SMOKE_LAYOUT explicitly adds the demo fixture matrix and is mandatory for template acceptance. Do not silently skip a requested fixture. Derive utility cache paths only after configuring the selected userData directory.

## Architecture checks

Cross-cutting source guards live in apps/web/tests/architecture and run with the Web Vitest project. They enforce app-to-host isolation, private feature modules (including demo), and production-to-test isolation for literal module references, including re-exports and dynamic imports. Colocated test files and testing/ helpers are exempt as consumers; runtime-computed module paths are not statically checked. Keep unit tests beside their implementation.
