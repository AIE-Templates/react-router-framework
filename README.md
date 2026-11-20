# React Router workspace

A pnpm workspace with React Router framework mode. The web application defaults to server rendering and can build as an SPA.

Use Node.js 24.15+ in the 24.x line, or Node.js 26 and newer and the pnpm version declared in package.json. Install with pnpm install; other package managers are rejected.

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
| `pnpm dev`                  | `pnpm --filter web dev`                                           |
| `pnpm dev:desktop`          | `pnpm --dir apps/desktop dev`                                     |
| `pnpm dev:server`           | `pnpm --filter @repo/server dev`                                  |
| `pnpm dist:desktop`         | `pnpm build:desktop && pnpm --dir apps/desktop dist`              |
| `pnpm fmt`                  | `oxfmt`                                                           |
| `pnpm fmt:check`            | `oxfmt --check`                                                   |
| `pnpm lint`                 | `pnpm typegen && oxlint`                                          |
| `pnpm lint:fix`             | `pnpm typegen && oxlint --fix`                                    |
| `pnpm package:desktop`      | `pnpm build:desktop && pnpm --dir apps/desktop package`           |
| `pnpm start`                | `pnpm --filter web start`                                         |
| `pnpm build:desktop:test`   | `pnpm --dir apps/desktop build:test --with-web`                   |
| `pnpm package:desktop:test` | `pnpm build:desktop:test && pnpm --dir apps/desktop package:test` |
| `pnpm start:desktop`        | `pnpm --dir apps/desktop start`                                   |
| `pnpm test`                 | `vitest`                                                          |
| `pnpm typecheck`            | `tsc -p tsconfig.json && pnpm -r typecheck`                       |
| `pnpm typegen`              | `pnpm --filter web exec react-router typegen`                     |
| `pnpm verify:build`         | `pnpm --dir apps/desktop verify:build`                            |
| `pnpm verify:release`       | `pnpm --dir apps/desktop verify:release`                          |

Vitest runs in watch mode by default; use pnpm exec vitest run for a finite run. Build Docker images from the workspace root so workspace dependencies are available. Package READMEs describe deployment and environment configuration. Keep secrets in local/environment configuration, never in the repository.

The production build runner sets `NODE_ENV=production` and removes inherited desktop development flags before running either the recursive workspace build or the Web and desktop builds. Development commands keep their own watch environment. Package-local desktop builds consume the existing Web build; root desktop packaging commands rebuild both first. `pnpm start:desktop` opens the packaged release app with the arguments you supply. It uses the installed app's normal user data, credential store and single-instance lock by default. To isolate a manual check, supply a fresh `"--user-data-dir=<absolute path>"` and, on macOS, `--use-mock-keychain` or, on Linux, `--password-store=basic`. On Linux the launcher reports a blocked Chromium sandbox and exits 1 before starting the app.

Build both profiles against one Web build when verifying a package:

```bash
pnpm build:desktop
pnpm --dir apps/desktop build:test
pnpm verify:build --no-build
pnpm --dir apps/desktop package:test
pnpm --dir apps/desktop package
pnpm verify:release --no-build
```

For distribution, configure signing (including a macOS signing identity and notarization), run `pnpm --dir apps/desktop dist` in place of the release packaging step, then run `pnpm verify:release --no-build --distribution`. Build NSIS on Windows so the receipt covers the signed installer and its matching application.

Clear `apps/desktop/.vite` and `apps/desktop/out` once when migrating from the old test-default commands. Rebuild the test profile explicitly before using Playwright, smoke or bench.

## Design

[Design specs](docs/specs/README.md) describe settled contracts; [ADRs](docs/adrs/) explain accepted decisions. AppRoot, AppShell and ModuleLayout separate environment, application framing and module state. Components use useAppEnvironment; document attributes only mirror its state.

## Derived application identity

Before distribution, replace the placeholder app ID, product/package name, app protocol, icons and installer metadata in desktop package/build configuration. Configure signing, notarization, update channels and platform installation separately. The test package (`out/test`) is never distributed; installers come only from the release profile. See apps/desktop/README.md.

## Scroll and landmarks

ContentScrollRestoration tracks root/module containers by history key, resets new navigation, restores back/forward and resolves fragments. It retains at most 100 entries within the current document. ModuleLayout defaults to div; choose one top-level contentAs="main" or provide one main element. moduleId must be unique per page. Use Router Link for application navigation.

## Visual preferences

VisualManager owns color scheme (`auto`, `light`, `dark`), text direction (`ltr`, `rtl`) and reduced motion (`auto`, `reduce`, `full`). Read `useVisualState` and update through `useVisualActions`; `useVisualStatus` distinguishes initialization and persistence failures. Global providers are composed by AppRoot, while the domain provider and registries live under `managers/visual`.

The head initializer applies saved preferences before paint. Core uses `data-color-scheme`, `dir` and `data-reduced-motion`; missing automatic values fall back to system CSS media queries. Set `APP_ID` in `packages/shared/src/app-identity.ts` before distributing an independent application. `config/storage.ts` derives Web keys through the shared `storageKey()` helper. The body-only AppUiProvider slot hosts UI integrations. See the [visual specification](docs/specs/visual.spec.md) for snapshot, reset and persistence behavior.

## Source structure

Feature routes and demo code live under `apps/web/src/app/features`; shared appearance controls live in `components/appearance-settings.tsx`. Environment contracts are consumed through `managers/environment/hooks` and `dom-props`, with the runtime owned by AppRoot. Global CSS enters through `styles/index.css`; component CSS Modules remain colocated. See the [structure specification](docs/specs/structure.spec.md) for boundaries, naming and migration rules.

## Mantine UI

The web app includes Mantine controls, modals and notifications. See the Web README for the provider, theme and stylesheet entry points.
