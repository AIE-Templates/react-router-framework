# React Router workspace

A pnpm workspace with React Router framework mode. The web application defaults to server rendering and can build as an SPA.

Use Node.js 24 or newer and the pnpm version declared in package.json. Install with pnpm install; other package managers are rejected.

## Packages

- [apps/web](apps/web/README.md): React Router application.
- [packages/server](packages/server/README.md): Standalone and in-process Hono API.
- [packages/shared](packages/shared/README.md): Browser-safe shared contracts.

## Commands

Run from the workspace root.

| Command           | Implementation                                |
| ----------------- | --------------------------------------------- |
| `pnpm build`      | `pnpm -r build`                               |
| `pnpm dev`        | `pnpm --filter web dev`                       |
| `pnpm dev:server` | `pnpm --filter @repo/server dev`              |
| `pnpm fmt`        | `oxfmt`                                       |
| `pnpm fmt:check`  | `oxfmt --check`                               |
| `pnpm lint`       | `pnpm typegen && oxlint`                      |
| `pnpm lint:fix`   | `pnpm typegen && oxlint --fix`                |
| `pnpm start`      | `pnpm --filter web start`                     |
| `pnpm test`       | `vitest`                                      |
| `pnpm typecheck`  | `tsc -p tsconfig.json && pnpm -r typecheck`   |
| `pnpm typegen`    | `pnpm --filter web exec react-router typegen` |

Vitest runs in watch mode by default; use pnpm exec vitest run for a finite run. Build Docker images from the workspace root so workspace dependencies are available. Package READMEs describe deployment and environment configuration. Keep secrets in local/environment configuration, never in the repository.

## Design

[Design specs](docs/specs/README.md) describe settled contracts; [ADRs](docs/adrs/) explain accepted decisions. AppRoot, AppShell and ModuleLayout separate environment, application framing and module state. Components use useAppEnvironment; document attributes only mirror its state.

## Scroll and landmarks

ContentScrollRestoration tracks root/module containers by history key, resets new navigation, restores back/forward and resolves fragments. It retains at most 100 entries within the current document. ModuleLayout defaults to div; choose one top-level contentAs="main" or provide one main element. moduleId must be unique per page. Use Router Link for application navigation.
