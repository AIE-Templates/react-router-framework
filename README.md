# React Router workspace

A pnpm workspace with React Router framework mode. The web application is a static SPA.

Use Node.js 24 or newer and the pnpm version declared in package.json. Install with pnpm install; other package managers are rejected.

## Packages

- [apps/web](apps/web/README.md): React Router application.
- [packages/shared](packages/shared/README.md): Browser-safe shared contracts.

## Commands

Run from the workspace root.

| Command          | Implementation                                |
| ---------------- | --------------------------------------------- |
| `pnpm build`     | `pnpm -r build`                               |
| `pnpm dev`       | `pnpm --filter web dev`                       |
| `pnpm fmt`       | `oxfmt`                                       |
| `pnpm fmt:check` | `oxfmt --check`                               |
| `pnpm lint`      | `pnpm typegen && oxlint`                      |
| `pnpm lint:fix`  | `pnpm typegen && oxlint --fix`                |
| `pnpm start`     | `pnpm --filter web start`                     |
| `pnpm test`      | `vitest`                                      |
| `pnpm typecheck` | `tsc -p tsconfig.json && pnpm -r typecheck`   |
| `pnpm typegen`   | `pnpm --filter web exec react-router typegen` |

Vitest runs in watch mode by default; use pnpm exec vitest run for a finite run. Build Docker images from the workspace root so workspace dependencies are available. Package READMEs describe deployment and environment configuration. Keep secrets in local/environment configuration, never in the repository.

## Design

[Design specs](docs/specs/README.md) describe settled contracts; [ADRs](docs/adrs/) explain accepted decisions. AppRoot, AppShell and ModuleLayout separate environment, application framing and module state. Components use useAppEnvironment; document attributes only mirror its state.

## Scroll and landmarks

ContentScrollRestoration tracks root/module containers by history key, resets new navigation, restores back/forward and resolves fragments. It retains at most 100 entries within the current document. ModuleLayout defaults to div; choose one top-level contentAs="main" or provide one main element. moduleId must be unique per page. Use Router Link for application navigation.

## Visual preferences

VisualManager owns color scheme (`auto`, `light`, `dark`), text direction (`ltr`, `rtl`) and reduced motion (`auto`, `reduce`, `full`). Read `useVisualState` and update through `useVisualActions`; `useVisualStatus` distinguishes initialization and persistence failures. Global providers are composed by AppRoot, while the domain provider and registries live under `managers/visual`.

The head initializer applies saved preferences before paint. Core uses `data-color-scheme`, `dir` and `data-reduced-motion`; missing automatic values fall back to system CSS media queries. Storage identifiers are centralized in `config/storage.ts`: choose your application ID before distributing an independent application. The body-only AppUiProvider slot hosts UI integrations. See the [visual specification](docs/specs/visual.spec.md) for snapshot, reset and persistence behavior.
