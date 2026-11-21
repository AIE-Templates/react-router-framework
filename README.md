# React Router workspace

A pnpm workspace with React Router framework mode. The web application defaults to server rendering and can build as an SPA.

Use Node.js 24.15+ in the 24.x line, or Node.js 26 and newer and the pnpm version declared in package.json. Install with pnpm install; other package managers are rejected.

## Quick start

```bash
pnpm install
pnpm dev
```

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

[Design specs](docs/specs/README.md) describe settled contracts and rationale:

- **Layout and environment** ([layout.spec.md](docs/specs/layout.spec.md)): `AppRoot`, `AppShell` and `ModuleLayout` separate environment, application framing and module state. Components read `useAppEnvironment()`; `ContentScrollRestoration` manages container scroll per history key.
- **Visual preferences** ([visual.spec.md](docs/specs/visual.spec.md)): `VisualManager` owns color scheme, text direction and reduced motion, with a prepaint head initializer and a body-only `AppUiProvider` slot for UI integrations.
- **Source structure** ([structure.spec.md](docs/specs/structure.spec.md)): Feature routes and disposable demo code live under `apps/web/src/app/features`; global CSS enters through `styles/index.css` while component CSS Modules remain colocated.

## Derived application identity

Before distributing an independent application, set `APP_ID` in `packages/shared/src/app-identity.ts` (storage and preference keys derive from it). Remove `apps/web/src/app/features/demo` and its route registrations in `apps/web/src/app/routes.ts` when replacing the template home page.
