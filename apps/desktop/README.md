# Desktop

Electron hosts the shared web application through `app://app`. Main maps requests to an internal HTTP origin and sends them over port-fetch to a utility process running Hono. Production pages and API use no TCP listener. Preload is sandboxed CommonJS; main is CommonJS; utility is ESM. Static resources belong to the web host, not a second main-process server.

The [host specification](../../docs/specs/electron-shell.spec.md), [layout specification](../../docs/specs/layout.spec.md), [window chrome specification](../../docs/specs/window-chrome.spec.md) and [ADRs](../../docs/adrs/) define the contracts and rationale.

## Commands

```bash
pnpm dev:desktop
pnpm build:desktop
pnpm package:desktop
pnpm release:desktop
pnpm dist:desktop
DESKTOP_SMOKE=1 DESKTOP_SMOKE_LAYOUT=1 DESKTOP_BOOT_PROFILE=1 pnpm --filter desktop start
pnpm --filter desktop test:e2e
```

Development uses a separate Router server on port 5174 (DESKTOP_DEV_PORT overrides it), preserves app:// mapping, watches bundles, restarts after main/utility changes and reloads after preload changes. Development user data is isolated. Root packaging commands build first; package-local scripts package existing artifacts. Test-profile permits the Playwright Electron driver. Release-profile disables inspector-related Fuses and must be checked with its built-in smoke path.

Root `build` and `build:desktop` normalize the build environment to production and clear inherited desktop development flags before building Web and desktop code. Non-watch desktop bundles contain production dependencies and no development server URL; the utility also runs with `NODE_ENV=production`. Use `dev:desktop` for watch mode. `LOG_LEVEL`, storage options and permitted diagnostic flags remain runtime settings. Package-local `build` consumes the existing Web build; use root `build:desktop` before distribution.

Before distributing a derived application, replace its name, app ID, product name, protocol identity, icons, installer metadata and signing/distribution settings in package/build configuration. Configured targets are dmg/zip, NSIS and deb/rpm; rpmbuild is needed for rpm. Automatic updates, signing and notarization are not implied by these targets. Native dependencies require Electron ABI/rebuild validation.

## Window chrome and recovery

Native-overlay is the default on macOS, Windows and Linux. DESKTOP_CHROME_MODE=system-decorated selects a native title bar. Reserved custom-controls falls back to system decoration. Bootstrap supplies immutable host/mode facts; state subscription supplies revisioned focus/maximize/fullscreen facts; appearance updates accept bounded color/height values. Preload does not expose arbitrary IPC or window-control commands.

Run `pnpm --filter desktop exec electron scripts/wco-probe.cjs` (optionally `--system-decorated`) for WCO safety probes. CSS geometry must remain safe before hydration, after errors and without external styles. Native drag/menu/resize behavior requires real platform checks.

Main-document failures use one automatic reload per bounded failure cycle, coordinated with utility generations; repeated failures show Reload/Close. Unresponsive offers Wait/Reload/Close. Reload may lose unsaved renderer state. Native dialogs do not introduce a new trusted page origin.

## Storage and trust

Server cookies round-trip through main's session cookie jar at the internal HTTPS storage origin. Main strips renderer-supplied Cookie/desktop headers, injects trusted values and flushes mutations before response delivery. Page scripts have no document.cookie. localStorage, sessionStorage and IndexedDB remain available. Storage E2E covers IndexedDB transactions across reload, window reopen and process restart, including persisted deletion.

Small display preferences use `~/platform/electron/preferences`: server getPreference; component useSetPreference; non-React writePreference. Desktop writes persist atomically in prefs.json and reach SSR in x-desktop-prefs. Web uses names derived from `PREFERENCE_COOKIE_PREFIX = cookieName("pref_")` in `@repo/shared` (default `framework-app_pref_`). Old `pref-*` cookies are intentionally ignored; visual preference storage and visual cookie names retain their existing derived values. Shared limits apply to both transports. Preferences are user-controlled display settings, never authorization or credentials.

Every IPC validates the registered window, current main frame and app URL. Navigation stays on app://app; allowed external links open in the system browser. No Node integration is available to pages. Logs exclude secrets and complete cookie/preference payloads. URL fields use `src/main/log-url.ts` to remove credentials, query and fragment and cap their length. Absolute URLs in Error messages/stacks and forwarded renderer console text receive the same treatment. Callers must still keep secrets out of paths, free text and other structured fields; this is not a general secret scrubber. Renderer console forwarding is limited to the main frame during development and smoke.

External sub-frame navigation and redirects are blocked without opening the system browser; same-origin sub-frames remain allowed. The application session denies permissions by default. Only verified application main frames may use sanitized clipboard writes and fullscreen; external-opening permission also validates an explicit http/https/mailto target. Device, notification and media permissions are denied. Extend `src/main/permissions.ts` with permission-specific checks when a product needs more capabilities; macOS media access also requires usage descriptions and OS consent. See HOST-10 in the host specification.

## Tests and measurement

### Controlled failures

`e2e/demo-visual.spec.ts` includes a storage-failure recovery example, tagged `@demo`. It fails only the appearance key's `Storage.setItem` after startup, drives the real controls, checks the warning and continued editing, then restores storage and verifies the next command saves the unsaved preferences across a reload. The original method is restored in `finally`; each test has isolated user data. Run it against both targets after building/packaging:

```sh
pnpm --filter desktop test:e2e demo-visual.spec.ts --grep 'failed appearance save'
```

Use the same approach for derived application failures: intercept a specific request or storage/bridge boundary while keeping production components and providers intact. Assert the user-visible failure, absence of incorrect state changes, successful recovery and unexpected page errors. Use deferred gates for delayed/out-of-order responses; arbitrary sleeps are not evidence of correct ordering. Do not add production fault switches or make host tests depend on disposable demo UI. Network interception validates the client's response to a constructed failure, not the real service's reasons for returning it. This storage test covers localStorage persistence, not native mirror failures or disk durability.

### Running checks

Build/package the test profile before running both Playwright targets. `pnpm --filter desktop test:e2e --project unpackaged` needs only build:desktop. Each test uses separate user data and closes its processes. Test endpoints require DESKTOP_E2E=1 and are unavailable in release-profile. These E2E tests are separate from workspace unit tests.

DESKTOP_SMOKE emits SMOKE_RESULT and exits with a status. DESKTOP_SMOKE_SCREENSHOT writes a PNG. Its SSE test verifies the transport path, not a business streaming API. DESKTOP_BOOT_PROFILE emits stage timings; compare repeated same-environment medians. Utility uses NODE_COMPILE_CACHE in userData. Release cookie encryption may prompt macOS for access to the application's Safe Storage keychain item.

```bash
pnpm build:desktop
pnpm --filter desktop bench --rounds 5 --measure-ms 10000 --warmup-ms 2000
pnpm --filter desktop bench compare bench-results/<file>.jsonl
```

The benchmark runner does not build. Real-app benchmarks run only in unpackaged/test-profile production paths, not release-profile or the dev server. DESKTOP_PORT_ACK_COALESCE=0 disables ACK batching for comparisons; default enables it. `.env.example` documents process environment options; the desktop host does not itself load a .env file. BENCH_VERBOSE passes Chromium stderr through.

## Project identity and imports

`src/main/app-url.ts` owns `APP_SCHEME`, `APP_HOST`, `APP_ORIGIN` and `isAppUrl`. The origin stays `app://app`, independently of product naming and shared `APP_ID`. Separate userData directories isolate applications; changing the origin within an existing directory requires migrating localStorage and IndexedDB.

When deriving an application, set `APP_ID` in `@repo/shared/src/app-identity.ts`, `productName` in this app's `package.json`, and `appId` in `electron-builder.yml`. Keep the builder's `productName` equal to package metadata; a test checks this. Change the other distribution placeholders listed above as well.

Electron's default userData is `<appData>/<app.name>`; `app.name` uses `productName` when present, otherwise package `name`. Builder `appId` does not choose that directory. `prefs.json`, `visual-theme.json` and `compile-cache/` retain their filenames within the selected application directory. Development and E2E continue using their existing isolated locations.

Here `~/` resolves to `src` in TypeScript and Vite/Vitest. Native Node `scripts/` and `e2e/` can use standalone `import type { ... } from "~/..."`, which is erased; they cannot use runtime alias imports or inline `import { type X }`, which retains an import statement. Runtime sharing across applications goes through workspace packages or the web build package, not relative source paths.

Packaged E2E paths follow the builder's default executable names: macOS uses `<productName>.app/Contents/MacOS/<productName>`, Windows uses `<productName>.exe`, and Linux uses the lowercased package `name` (currently `desktop`), not `productName`. The helper selects the existing architecture-specific output directory. `executableName` overrides are not supported by this template's launcher and are rejected by configuration tests.

Keep both package `name` and `productName` portable for that path helper: an ASCII letter first, then ASCII letters, digits, spaces, dots, underscores or hyphens; no trailing dot/space or Windows reserved filename. The helper validates this constraint instead of approximating electron-builder's filename sanitization. Product names may contain spaces; package names must also satisfy package-manager metadata requirements.

## Diagnostic suites

Runtime window, storage and transport code stays in `src/main`. Benchmark runners and routes live in `src/diagnostics/bench`; smoke runners, layout measurements and routes in `src/diagnostics/smoke`; E2E utility routes in `src/diagnostics/e2e`. Release/test-profile restrictions remain owned by `main/run-modes.ts`.

`DESKTOP_SMOKE=1 pnpm --filter desktop start` runs the application suite (bootstrap, transport, styles, window safety and reload/error recovery). It does not require the demo homepage. `DESKTOP_SMOKE=1 DESKTOP_SMOKE_LAYOUT=1 pnpm --filter desktop start` additionally runs the template layout fixture matrix against `features/demo`. Template acceptance must explicitly enable this matrix; a requested matrix with missing controls fails rather than silently skipping. The result identifies `suite: application` or `suite: template-layout`. Business projects may delete demo and its route registration and keep the application suite. `test:e2e:host` runs host contracts against the real application root without requiring demo controls; `test:e2e:demo` selects the `@demo` suites in `demo-layout.spec.ts` and `demo-visual.spec.ts`. The full `test:e2e` command includes both and remains required for template acceptance. Derived projects can remove or replace the demo suites without removing host tests.

The layout fixture uses named `data-demo-shell` / `data-demo-header` controls and `data-module-panel-toggle` attributes, independent of control order and translated button labels.
