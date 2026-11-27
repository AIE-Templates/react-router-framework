# Contributor instructions

## Workspace

Use pnpm and the Node version declared in package.json. Shared TypeScript, Oxlint, Oxfmt, Vitest, Lefthook and commitlint configuration lives at the workspace root. Run workspace commands there. React Router application source is apps/web/src/app, imported with `~/`; native Node entry/config files and public assets remain at the app root.

Before changing Router routes, loaders, actions or integration, read `.agents/skills/react-router/SKILL.md`, its framework-mode reference and the matching installed Router documentation.

## Checks and tests

Run full test suites through Orca on the Windows host. Use a temporary branch to sync work in progress when needed.

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

This branch builds a static SPA with ssr: false.

SPA builds reject non-root server loaders, server actions/middleware/headers and non-root HydrateFallback. The root loader runs at build time. Components, meta, links, ErrorBoundary and client data APIs can support both modes. Select rendering requirements deliberately rather than assuming every application can switch unchanged.

Keep default root revalidation. Optimize only after checking loader dependencies and explicit invalidation; an in-flight navigation can have different current/next URLs even during revalidate(). See apps/web/README.md for dependency optimization, route discovery and revalidation guidance.

## Application infrastructure

Async results belong to the resource, identity and operation that started them. Propagate cancellation and recheck ownership after awaits before publishing state, writing a cache or navigating. Invalidate old owners before clearing caches; checking only whether a component is mounted is insufficient. Do not suppress errors from the current owner. See the async ownership example in apps/web/README.md; reuse existing lifecycle guards before adding abstractions.

Compose global providers in AppRoot. Components read useAppEnvironment from ~/managers/environment/hooks; never infer host identity from user agents, query parameters or data-shell. Do not call the bridge during rendering. Root loader data seeds hydration; confirmed preload identity survives revalidation.

Choose app areas from the page layout. The same routes and features can share one area or span several. BasicShell frames one area; NavigationShell also hosts the area switcher. Implement each area's layout to suit the product. For fused headers, render WindowLayout inside the shell and put each header and its content in a WindowColumn. Mark one visible column primary. AppAreaLayout uses these primitives for the CRM demo. For a custom layout with a separate title bar, use the shell's standalone header mode. Read native control geometry from the environment CSS variables. A custom layout can claim the root reservation with data-window-safe-area-owner independently of its drag regions. Window IPC stays in host integration. See docs/specs/layout.spec.md for the fused header contract.

Mark top interactive elements with getInteractiveProps and drag regions with getDragRegionProps. Inline CHROME_SAFETY_CSS and retain .root-chrome-fallback outside route children for normal, fallback and error documents. Safety geometry cannot depend on provider/bootstrap readiness. CHROME_SAFETY_CSS remains inline and unlayered; the global stylesheet entry rule does not move it into styles/. Environment runtime/context/hooks/dom-props live in managers/environment. AppRoot creates the environment runtime directly; it is not a ManagersRegistry member. The reusable appearance panel lives in components/appearance-settings.tsx.

Layer ordering remains a convention; architecture tests enforce the app/host, feature and test boundaries. Production features use shared components/layouts/hooks, then managers/services, then lib/utils/config. Providers are composition points used by root/entry.server; testing/render.tsx composes them for ordinary UI tests. Specialized provider/lifecycle tests may mount providers directly. New resource APIs belong in services/ when needed; no Core ApiClient is introduced.

@repo/shared must remain browser-importable with no node: imports or runtime dependencies. Resolve source through @repo/source in workspace Vite, Vitest and TypeScript configuration; new consumers need the same condition.

## Visual state

VisualManager owns preferences, storage and system resolution. Use useVisualState/useVisualActions; do not write its storage key directly. Registry components only compose providers. Keep sparse choices and stamped records separate from build-time VISUAL_DEFAULTS in @repo/shared. Use visualRecordKernel.effective(snapshot) for control values and snapshot.resolved for display. Keep the shared record factory and visualKernel self-contained for production prepaint. Only connect or user commands may access live storage and bridges. AppUiProvider is the body UI integration slot; never put style-producing providers around html. Keep server and client snapshots separate and do not overwrite prepaint attributes with hydration defaults.

Application identity is defined once in @repo/shared app-identity.ts. Choose APP_ID when creating a project; config/storage.ts derives keys through storageKey(). Color tokens use --app-color-* and are the source for Tailwind aliases and UI-library adapters. BREAKPOINTS in config/breakpoints.ts owns viewport media-query widths in em. CSS naming and media-query source guards run with the Web tests; reviewed exceptions require a same-line naming-allow: reason comment.

## Architecture checks

Cross-cutting source guards live in apps/web/tests/architecture and run with the Web Vitest project. They enforce app-to-host isolation, private feature modules (including demo), and production-to-test isolation for literal module references, including re-exports and dynamic imports. Colocated test files and testing/ helpers are exempt as consumers; runtime-computed module paths are not statically checked. Keep unit tests beside their implementation.
