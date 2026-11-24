# React Router workspace

A pnpm workspace with React Router framework mode. The web application defaults to server rendering and can build as an SPA.

Use Node.js 24.15+ in the 24.x line, or Node.js 26 and newer and the pnpm version declared in package.json. Install with pnpm install; other package managers are rejected.

## Quick start

```bash
pnpm install
pnpm dev          # web development server
pnpm dev:desktop  # Electron development app
```

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

| Command                     | Implementation                                                    |
| --------------------------- | ----------------------------------------------------------------- |
| `pnpm bench:transport`      | `pnpm --filter @repo/bench-transport bench --`                    |
| `pnpm build`                | `node apps/desktop/scripts/build.ts --workspace`                  |
| `pnpm build:desktop`        | `pnpm --dir apps/desktop build --with-web`                        |
| `pnpm build:desktop:test`   | `pnpm --dir apps/desktop build:test --with-web`                   |
| `pnpm dev`                  | `pnpm --filter web dev`                                           |
| `pnpm dev:desktop`          | `pnpm --dir apps/desktop dev`                                     |
| `pnpm dev:server`           | `pnpm --filter @repo/server dev`                                  |
| `pnpm dist:desktop`         | `pnpm build:desktop && pnpm --dir apps/desktop dist`              |
| `pnpm fmt`                  | `oxfmt`                                                           |
| `pnpm fmt:check`            | `oxfmt --check`                                                   |
| `pnpm lint`                 | `pnpm typegen && oxlint`                                          |
| `pnpm lint:fix`             | `pnpm typegen && oxlint --fix`                                    |
| `pnpm package:desktop`      | `pnpm build:desktop && pnpm --dir apps/desktop package`           |
| `pnpm package:desktop:test` | `pnpm build:desktop:test && pnpm --dir apps/desktop package:test` |
| `pnpm start`                | `pnpm --filter web start`                                         |
| `pnpm start:desktop`        | `pnpm --dir apps/desktop start`                                   |
| `pnpm test`                 | `vitest`                                                          |
| `pnpm typecheck`            | `tsc -p tsconfig.json && pnpm -r typecheck`                       |
| `pnpm typegen`              | `pnpm --filter web exec react-router typegen`                     |
| `pnpm verify:build`         | `pnpm --dir apps/desktop verify:build`                            |
| `pnpm verify:release`       | `pnpm --dir apps/desktop verify:release`                          |

Vitest runs in watch mode by default; use pnpm exec vitest run for a finite run. Build Docker images from the workspace root so workspace dependencies are available. Package READMEs describe deployment and environment configuration. Keep secrets in local/environment configuration, never in the repository.

Desktop production builds normalize `NODE_ENV=production` and clear inherited development flags. Root desktop packaging commands rebuild Web first, while package-local commands reuse the existing Web build. To verify both desktop profiles against one Web build:

```bash
pnpm build:desktop
pnpm --dir apps/desktop build:test
pnpm verify:build --no-build
pnpm --dir apps/desktop package:test
pnpm --dir apps/desktop package
pnpm verify:release --no-build
```

See [apps/desktop/README.md](apps/desktop/README.md) for manual release launch isolation, signing, notarization and Windows installer details.

## Design

[Design specs](docs/specs/README.md) describe settled contracts and rationale:

- **Layout and environment** ([layout.spec.md](docs/specs/layout.spec.md)): `AppRoot` provides the host environment. `BasicShell` and `NavigationShell` frame the current app area. `AppAreaLayout` organizes its main content and optional panels. Components read `useAppEnvironment()`; `ContentScrollRestoration` manages container scroll per history key.
- **Visual preferences** ([visual.spec.md](docs/specs/visual.spec.md)): `VisualManager` owns color scheme, text direction and reduced motion, with a prepaint head initializer and a body-only `AppUiProvider` slot for UI integrations.
- **Source structure** ([structure.spec.md](docs/specs/structure.spec.md)): Feature routes and disposable demo code live under `apps/web/src/app/features`; global CSS enters through `styles/index.css` while component CSS Modules remain colocated.
- **Desktop host and chrome** ([electron-shell.spec.md](docs/specs/electron-shell.spec.md), [window-chrome.spec.md](docs/specs/window-chrome.spec.md)): `app://app` maps to an in-process Hono utility host over `port-fetch`, with compiled build profiles (`dev`, `test`, `release`) and native overlay window chrome.

## Derived application identity

Before distributing an independent application, set `APP_ID` in `packages/shared/src/app-identity.ts` (storage and preference keys derive from it) and replace the placeholder desktop `appId`, `productName`, package name, app protocol, icons and installer metadata. Remove `apps/web/src/app/features/demo` and its route registrations in `apps/web/src/app/routes.ts` when replacing the template home page.

Configure signing, notarization, update channels and platform installation separately. The test package (`out/test`) is never distributed; installers come only from the release profile. See [apps/desktop/README.md](apps/desktop/README.md).

## Mantine UI

The web app includes Mantine controls, modals and notifications. See the [Web README](apps/web/README.md) and the [Mantine specification](docs/specs/mantine.spec.md) for the provider, theme and stylesheet entry points.
