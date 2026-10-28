# React Router workspace

A pnpm workspace with React Router framework mode. The web application defaults to server rendering and can build as an SPA.

Use Node.js 24 or newer and the pnpm version declared in package.json. Install with pnpm install; other package managers are rejected.

## Packages

- [apps/web](apps/web/README.md): React Router application.
- [packages/server](packages/server/README.md): Standalone and in-process Hono API.
- [packages/shared](packages/shared/README.md): Browser-safe shared contracts.
- [apps/desktop](apps/desktop/README.md): Electron host using app:// and a utility process.
- [packages/port-fetch](packages/port-fetch/README.md): Request/Response streams over message ports.
- [packages/channel](packages/channel/README.md): Bidirectional MessagePort/WebSocket channels and relay.
- [bench/transport](bench/transport/README.md): Repeatable transport benchmarks.

## Commands

Run from the workspace root.

| Command                | Implementation                                                |
| ---------------------- | ------------------------------------------------------------- |
| `pnpm bench:transport` | `pnpm --filter @repo/bench-transport bench --`                |
| `pnpm build`           | `pnpm -r build`                                               |
| `pnpm build:desktop`   | `pnpm --filter web build && pnpm --filter desktop build`      |
| `pnpm dev`             | `pnpm --filter web dev`                                       |
| `pnpm dev:desktop`     | `pnpm --filter desktop dev`                                   |
| `pnpm dev:server`      | `pnpm --filter @repo/server dev`                              |
| `pnpm dist:desktop`    | `pnpm build:desktop && pnpm --filter desktop dist:release`    |
| `pnpm fmt`             | `oxfmt`                                                       |
| `pnpm fmt:check`       | `oxfmt --check`                                               |
| `pnpm lint`            | `pnpm typegen && oxlint`                                      |
| `pnpm lint:fix`        | `pnpm typegen && oxlint --fix`                                |
| `pnpm package:desktop` | `pnpm build:desktop && pnpm --filter desktop package`         |
| `pnpm release:desktop` | `pnpm build:desktop && pnpm --filter desktop package:release` |
| `pnpm start`           | `pnpm --filter web start`                                     |
| `pnpm test`            | `vitest`                                                      |
| `pnpm typecheck`       | `tsc -p tsconfig.json && pnpm -r typecheck`                   |
| `pnpm typegen`         | `pnpm --filter web exec react-router typegen`                 |

Vitest runs in watch mode by default; use pnpm exec vitest run for a finite run. Build Docker images from the workspace root so workspace dependencies are available. Package READMEs describe deployment and environment configuration. Keep secrets in local/environment configuration, never in the repository.

## Design

[Design specs](docs/specs/README.md) describe settled contracts; [ADRs](docs/adrs/) explain accepted decisions. AppRoot, AppShell and ModuleLayout separate environment, application framing and module state. Components use useAppEnvironment; document attributes only mirror its state.

## Derived application identity

Before distribution, replace the placeholder app ID, product/package name, app protocol, icons and installer metadata in desktop package/build configuration. Configure signing, notarization, update channels and platform installation separately. Test-profile packaging and hardened release-profile are distinct. See apps/desktop/README.md.
