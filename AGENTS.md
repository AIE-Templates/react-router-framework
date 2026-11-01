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

Use ~/ for app-root imports; ./ may reference the same directory or its children. Do not introduce ../ imports in application code. Cross-package imports use workspace package names. Features do not import one another. Keep reusable UI, hooks and pure helpers outside features when shared. Do not add barrel index.ts files under src/app. Colocate tests with their source; host-dependent integration tests belong to src/host when that layer exists. Create directories only when needed.

## Styling

Default to colocated CSS Modules named after the component, imported as classes with camelCase class names. Put module rules in @layer components so Tailwind utilities can override them; Tailwind remains optional and supported. Global stylesheet imports enter through styles/index.css, with layer order theme, base, mantine, components, utilities. Never use light-dark() or bare rem() in project styles. app.css is a temporary downstream migration bridge: only remove content, never add styles.

## Naming

Use kebab-case file and directory names, PascalCase component exports and useXxx hooks in use-xxx.ts files. Application CSS variables use --app-; reserve --app-shell-* for Mantine. Feature-local variables use --<feature>- on the feature root, never :root. Tailwind theme and third-party variables retain their own names. Data attributes use domain-name without an application prefix.

## Rendering

This branch builds a static SPA with ssr: false.

SPA builds reject non-root server loaders, server actions/middleware/headers and non-root HydrateFallback. The root loader runs at build time. Components, meta, links, ErrorBoundary and client data APIs can support both modes. Select rendering requirements deliberately rather than assuming every application can switch unchanged.
