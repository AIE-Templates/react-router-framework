# Contributor instructions

## Workspace

Use pnpm and the Node version declared in package.json. Shared TypeScript, Oxlint, Oxfmt, Vitest, Lefthook and commitlint configuration lives at the workspace root. Run workspace commands there. React Router application source is apps/web/src/app, imported with `~/`; native Node entry/config files and public assets remain at the app root.

Before changing Router routes, loaders, actions or integration, read `.agents/skills/react-router/SKILL.md`, its framework-mode reference and the matching installed Router documentation.

## Checks and tests

After changes run `pnpm lint:fix`, then `pnpm fmt`. Before completion run `pnpm exec oxlint --deny-warnings --format=agent`, `pnpm typecheck` and `pnpm test` (use `pnpm exec vitest run` for a finite run).

Unit tests use Vitest and Testing Library, colocated as *.test.ts(x). Each package has a Vitest project. Use createRoutesStub when components need Router context; invoke loaders/actions directly. Keep environment examples synchronized with new variables, document purpose/defaults and never commit .env files.

## Commits

Use Conventional Commits, checked by @commitlint/config-conventional. Lefthook runs Oxlint/Oxfmt on staged files. Do not bypass hooks with --no-verify.

## Rendering

SSR is the default; SSR=false at dev/build selects SPA.

SPA builds reject non-root server loaders, server actions/middleware/headers and non-root HydrateFallback. The root loader runs at build time. Components, meta, links, ErrorBoundary and client data APIs can support both modes. Select rendering requirements deliberately rather than assuming every application can switch unchanged.

## Application infrastructure

Compose global providers in AppRoot. Components read useAppEnvironment from ~/providers/environment; never infer host identity from user agents, query parameters or data-shell. Do not call the bridge during rendering. Root loader data seeds hydration; confirmed preload identity survives revalidation.

Pages compose BasicShell or NavigationShell with ModuleLayout. Modules do not handle OS branches, native control geometry or window IPC. Mark top interactive elements with getInteractiveProps and drag regions with getDragRegionProps. Inline CHROME_SAFETY_CSS and retain .root-chrome-fallback outside route children for normal, fallback and error documents. Safety geometry cannot depend on provider/bootstrap readiness.

@repo/shared must remain browser-importable with no node: imports or runtime dependencies. Resolve source through @repo/source in workspace Vite, Vitest and TypeScript configuration; new consumers need the same condition.

## Server and host

packages/server is Hono, independently runnable under native Node and also hosted in-process. Use explicit .ts relative imports and erasable TypeScript; no enums, namespaces, parameter properties, import.meta.env or React Router dependency. Development-only behavior checks NODE_ENV === "development"; unset means production.

Keep host logic in apps/web/src/host. app.ts composes createServerApp with Router; web-app.ts adds static/SPA handling as createWebApp. server.ts only loads environment/build and starts production. getHostApp serves dev/prerender through the Vite adapter. Load .env only in react-router.config.ts and server.ts. Preserve dotenv 17.x/dotenv-expand 13.x; command substitution in newer expand versions needs review.

Keep source/dist export targets synchronized. Workspace imports use @repo/source. All packages use the same Hono version. API route chains live in packages/server/src/routes and mount under /api; unknown API routes return JSON 404. Browser/app imports from server are type-only via @repo/server/types; host/tests may import implementations.

Loaders/actions call context.get(apiContext) in-process; browser/client loaders use ~/lib/api. In-process calls forward request credentials, ID and cancellation, bypassing API CSRF. Put mutations in actions, never loaders; Router performs action origin checks. Native clients send JSON or matching Origin. Only trust forwarded headers behind a trusted proxy.

Pass request.signal to upstream fetch. Use createTestContext or a fake apiContext for loader tests and Hono testClient for API routes. Wrap deferred promises in logRejection with the request logger and signal; Router handleError does not capture these rejections. Hono stream/streamText/streamSSE callbacks use rethrowNonErrors and logStreamFailure. Log structured data first through c.var.logger or loggerContext, never console, credentials or full query strings.

Middleware extends the same host/server chain before Router fallback; do not wrap it in a second Hono app. Keep entry.server.tsx aligned with Router's default Node entry during upgrades. CSP uses one SSR document nonce for ServerRouter, React, Links, ScrollRestoration and Scripts; preserve it across revalidation. Static HTML uses sha256 hashes. Production script-src excludes unsafe-inline; configure additional resource origins explicitly.

In-process server data APIs provide SSR data and cookie forwarding but prevent SPA builds. Client data APIs support either build mode with a first-render skeleton and a browser request. Moving SSR server-data routes to SPA requires rewriting them.

## Desktop

apps/desktop uses Vite bundles and electron-builder. Main/preload are CommonJS; utility is ESM and runs createWebApp via port-fetch. Main must not import @repo/server or top-level await app.whenReady. Capture uncaught exceptions through logging, not blocking Electron default dialogs. Validate each IPC with isTrustedSender. Keep dependencies empty except required external native modules; bundle other dependencies.

Main maps app://app to the internal HTTP origin, injects trustworthy non-GET Origin and desktop state, and maps redirects back. Host identity comes only from entry configuration, never requests. Strip untrusted desktop headers; only a desktop entry trusts main-supplied values. Server redirects stay relative; request.url is not a public URL. Static files belong solely to the web host. Utility compile cache is in userData.

Port-fetch and channel must remain Electron-independent. Test with worker_threads MessageChannel and local ws. Port-fetch sends standalone Uint8Array chunks via structured cloning; do not use ArrayBuffer transfer lists with Electron MessagePortMain or assume zero-copy. Propagate cancellation through request.signal. Channel producers await whenDrained; send neither blocks nor drops. Relay preserves ordering/backpressure/close semantics; use shared CLOSE_CODES.

Desktop page document.cookie is unavailable. Main manages server cookies in the dedicated session and sends them only to the app upstream. Client-readable state uses loader data, localStorage or explicit helpers. Small display preferences use getPreference/useSetPreference/writePreference, never shell-specific business branches or direct cookie writes. Desktop persists prefs.json and injects x-desktop-prefs; web uses pref-* cookies. Both enforce shared key/size limits. Preferences are user-controlled and must never authorize access or store credentials.

Run build:desktop, DESKTOP_SMOKE=1 DESKTOP_BOOT_PROFILE=1 with desktop start, and check packaged artifacts (desktop package for test-profile; package:release changes Fuses). Desktop E2E uses Playwright with isolated userData and closes all launched processes. Build/package before both E2E targets; unpackaged needs only build. Test endpoints require DESKTOP_E2E=1 and never mount in release-profile. Release cannot be driven with the inspector-based test driver. Compare repeated boot-profile medians for startup changes. Specs live in docs/specs; decisions in docs/adrs.

Inline CHROME_SAFETY_CSS relies on the default CSP style-src unsafe-inline allowance; add a hash before tightening it.

## Visual state

VisualManager owns preferences, storage and system resolution. Use useVisualState/useVisualActions; do not write its storage key directly. Registry components only compose providers. Keep the serialized visualKernel self-contained: production prepaint execution is tested separately from module execution. AppUiProvider is the body UI integration slot; never put style-producing providers around html. Keep server and client snapshots separate and do not overwrite prepaint attributes with hydration defaults.
