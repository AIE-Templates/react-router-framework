# Desktop

Electron hosts the shared web application through `app://app`. Main maps requests to an internal HTTP origin and sends them over port-fetch to a utility process running Hono. Production pages and API use no TCP listener. Preload is sandboxed CommonJS; main is CommonJS; utility is ESM. Static resources belong to the web host, not a second main-process server.

The [host specification](../../docs/specs/electron-shell.spec.md), [layout specification](../../docs/specs/layout.spec.md), [window chrome specification](../../docs/specs/window-chrome.spec.md) and [ADRs](../../docs/adrs/) define the contracts and rationale.

## Commands

```bash
pnpm dev:desktop       # dev profile in .vite/dev, watch mode
pnpm build:desktop         # Web + release bundles
pnpm package:desktop       # Web + unpacked release app
pnpm start:desktop         # launch the packaged release app
pnpm dist:desktop          # Web + release installers
pnpm build:desktop:test    # Web + test bundles
pnpm package:desktop:test  # Web + unpacked test app
DESKTOP_SMOKE=1 DESKTOP_SMOKE_LAYOUT=1 DESKTOP_BOOT_PROFILE=1 pnpm --dir apps/desktop start:test
pnpm --filter desktop test:e2e
pnpm verify:build
pnpm verify:release
```

Three build profiles are fixed at build time; HOST-11 in the host specification lists what differs between them and [ADR 0011](../../docs/adrs/0011-build-profiles.md) records why. `dev` exists only while `dev:desktop` runs. `test` is what `build:desktop:test`, `package:desktop:test`, Playwright, the smoke and the benchmark use; package-local `build:test` selects it and `build` defaults to release. `release` is the shipped build: no smoke, benchmark or E2E endpoints, no development code, no debug variables, no DevTools, and it exits with status 97 when started with `--remote-debugging-port` or `--remote-debugging-pipe`. Both packages get the same fuses except the Node inspector, which only the test package keeps for Playwright's driver.

Development uses a separate Router server on port 5174 (DESKTOP_DEV_PORT overrides it), preserves app:// mapping, watches bundles, restarts after main/utility changes and reloads after preload changes. Development user data is `<userData>-dev` (DESKTOP_USER_DATA_SUFFIX changes the suffix). Root packaging commands build first; package-local `package:test`, `package` and `dist` package existing bundles after checking that they match the current Web build.

Root `build`, `build:desktop`, `package:desktop` and `dist:desktop` normalize the build environment to production and clear inherited development server variables before building Web and desktop code. Test and release bundles are minified and contain production dependencies and no development server URL; the utility also runs with `NODE_ENV=production`. Package-local `build` consumes the existing Web build; use a root command before packaging. `dist:desktop` builds the installers of the platform it runs on. Build the Windows installer on Windows: cross-built on macOS with electron-builder 26, it installs and runs but its uninstaller fails NSIS's integrity check (electron-builder#10258, fixed in 27); `verify:release --distribution` on Windows also verifies the native NSIS installer signature. `.env.example` lists which variables each profile reads.

The Windows installer requires an empty directory on first install. Upgrades reuse a registered installation whose uninstaller removes only its own packaged files; files outside the new and old payloads survive upgrades and uninstallation. Keep user documents outside the installation directory: a later version can ship a file of the same name and replace it. The installer refuses reparse points anywhere in the destination path (including junctions and some cloud-managed directories). After an interrupted first install with no registered uninstaller, choose a fresh empty directory or move the partial directory aside before retrying. An earlier installation without this ownership record is refused before its recursive uninstaller can run. Back up its directory and move all personal files outside it before using that older uninstaller; when the directory is the Desktop or another shared system folder, leave the old uninstaller alone and have an administrator migrate the application's files and registration. Then install into a new empty directory.

Before distributing a derived application, replace its name, app ID, product name, protocol identity, icons, installer metadata and signing/distribution settings in package/build configuration. Installer targets (dmg/zip, NSIS, deb/rpm; rpmbuild is needed for rpm) are built only from the release profile. Automatic updates, signing and notarization are not implied by these targets. Native dependencies require Electron ABI/rebuild validation.

## Window chrome and recovery

Native-overlay is the default on macOS, Windows and Linux. DESKTOP_CHROME_MODE=system-decorated selects a native title bar. Reserved custom-controls falls back to system decoration. Bootstrap supplies immutable host/mode facts; state subscription supplies revisioned focus/maximize/fullscreen facts; appearance updates accept bounded color/height values. Preload does not expose arbitrary IPC or window-control commands.

Run `pnpm --filter desktop exec electron scripts/wco-probe.cjs` (optionally `--system-decorated`) for WCO safety probes. CSS geometry must remain safe before hydration, after errors and without external styles. Native drag/menu/resize behavior requires real platform checks.

Main-document failures use one automatic reload per bounded failure cycle, coordinated with utility generations; repeated failures show Reload/Close/Cancel. Escape keeps affected windows open. Unresponsive offers Wait/Reload/Close and logs `window unresponsive` / `window responsive again`. A window whose renderer exits while it is closing is destroyed, so quitting cannot stall on it. Reload may lose unsaved renderer state. Native dialogs do not introduce a new trusted page origin.

## Storage and trust

Server cookies round-trip through main's session cookie jar at the internal HTTPS storage origin. Main strips renderer-supplied Cookie/desktop headers, injects trusted values and flushes mutations before response delivery. Page scripts have no document.cookie. localStorage, sessionStorage and IndexedDB remain available. Storage E2E covers IndexedDB transactions across reload, window reopen and process restart, including persisted deletion.

Small display preferences use `~/platform/electron/preferences`: server getPreference; component useSetPreference; non-React writePreference. Desktop writes persist atomically in prefs.json and reach SSR in x-desktop-prefs. Web uses names derived from `PREFERENCE_COOKIE_PREFIX = cookieName("pref_")` in `@repo/shared` (default `framework-app_pref_`). Old `pref-*` cookies are intentionally ignored; visual preference storage and visual cookie names retain their existing derived values. Shared limits apply to both transports. Preferences are user-controlled display settings, never authorization or credentials.

Every IPC validates the registered window, current main frame and app URL. Navigation stays on app://app; allowed external links open in the system browser. No Node integration is available to pages. Logs exclude secrets and complete cookie/preference payloads. URL fields use `src/main/log-url.ts` to remove credentials, query and fragment and cap their length. Absolute URLs in Error messages/stacks and forwarded renderer console text receive the same treatment. Callers must still keep secrets out of paths, free text and other structured fields; this is not a general secret scrubber. Renderer console forwarding is limited to the main frame during development and test-build smoke runs; release never forwards it.

External sub-frame navigation and redirects are blocked without opening the system browser; same-origin sub-frames remain allowed. The application session denies permissions by default. Only verified application main frames may use sanitized clipboard writes and fullscreen; external-opening permission also validates an explicit http/https/mailto target. Device, notification and media permissions are denied. Extend `src/main/permissions.ts` with permission-specific checks when a product needs more capabilities; macOS media access also requires usage descriptions and OS consent. See HOST-10 in the host specification.

## Tests and measurement

### Controlled failures

`e2e/demo-visual.spec.ts` includes a storage-failure recovery example, tagged `@demo`. It fails only the appearance key's `Storage.setItem` after startup, drives the real controls, checks the warning and continued editing, then restores storage and verifies the next command saves the unsaved preferences across a reload. The original method is restored in `finally`; each test has isolated user data. Run it against both targets after building/packaging:

```sh
pnpm --filter desktop test:e2e demo-visual.spec.ts --grep 'failed appearance save'
```

Use the same approach for derived application failures: intercept a specific request or storage/bridge boundary while keeping production components and providers intact. Assert the user-visible failure, absence of incorrect state changes, successful recovery and unexpected page errors. Use deferred gates for delayed/out-of-order responses; arbitrary sleeps are not evidence of correct ordering. Do not add production fault switches or make host tests depend on disposable demo UI. Network interception validates the client's response to a constructed failure, not the real service's reasons for returning it. This storage test covers localStorage persistence, not native mirror failures or disk durability.

### Running checks

Run `pnpm package:desktop:test` before both Playwright targets; `pnpm --filter desktop test:e2e --project unpackaged` needs only build:desktop:test. The packaged project runs after `packaged-fuses`, which reads the package's fuses back. These E2E tests are separate from workspace unit tests. Playwright attaches a debugger to every renderer, and an unresponsive renderer has not been reported under E2E (measured); check hangs with the smoke, the benchmark or `verify:release`. On macOS E2E refuses to start while the screen is locked.

Test launchers (Playwright, `start:test`, `bench`) share `scripts/launch.ts`. `launchSpec()` builds the command, arguments and environment: it requires a user data directory (`--user-data-dir`) and adds `--use-mock-keychain` on macOS and `--password-store=basic` on Linux, so the encrypted cookie store stays off the system keychain or keyring (measured on macOS) and the real credential store is not exercised. On macOS it also adds `-ApplePersistenceIgnoreState YES`, a test switch like the mock keychain that `verify:release` passes too: after the app crashed while opening its windows, AppKit otherwise stops the next launch before ready in its modal reopen-windows prompt, which nothing in a test run answers (measured). AppKit notes the switch on stderr. On Linux where Chromium's sandbox cannot start (root, user namespaces unavailable, Ubuntu's AppArmor restriction, which applies to any unpacked build, and no root-owned 4755 `chrome-sandbox`), it adds `--no-sandbox` and prints a notice; E2E otherwise keeps the sandbox on (`chromiumSandbox`). The launchers take a fresh directory from `freshUserDataDir()` per test, run or invocation and remove it afterwards, call `checkLaunchInputs()` to read a package's fuses back or check unpackaged bundles against the Web build, and check the reported test profile with `verifyBuildProfile()` (Playwright: the fixture evaluates `desktopBuildProfile`).

`pnpm --dir apps/desktop start:test` runs the unpackaged test bundles; `start:test --packaged` runs `out/test` and `start:test --app <executable>` another packaged test app. Extra arguments go to Electron; `--user-data-dir=<dir>` is kept afterwards. On macOS and Linux the app runs in its own process group, so Ctrl+C or a signal to the launcher's group never reaches its helper processes directly; each SIGINT, SIGTERM or SIGHUP is passed at once to the app's main process, a second one again, and a third kills the app's process group. A launcher killed outright (SIGKILL, or a CI job's process-group kill, which does not reach the app's separate group) cannot pass anything on: the app keeps running and its temporary user data directory stays behind (measured on Linux). Signalling the app's own group instead can make Chromium abort on Linux (measured). On Windows any of these signals terminates the app.

DESKTOP_SMOKE emits SMOKE_RESULT and exits with a status. DESKTOP_SMOKE_SCREENSHOT writes a PNG. Its SSE test verifies the transport path, not a business streaming API. DESKTOP_BOOT_PROFILE emits stage timings, including `cookie-key-writer-ms` on Windows when the cookie key writer ran, which it does on every fresh profile; compare repeated same-environment medians. Utility uses NODE_COMPILE_CACHE in userData. A release package outside `verify:release` may prompt macOS for the application's Safe Storage keychain item.

### Release verification

`pnpm verify:build` needs an existing Web build (`pnpm build:desktop`) and runs through pnpm, which its build step requires. It builds the test and release bundles and checks, from the bundler's module records and the bundle text, that release contains no diagnostics, development host, debug variable names or diagnostic markers and carries the remote debugging refusal; the test bundles must show every marker that belongs to them. `--no-build` checks the bundles on disk.

`pnpm verify:release` verifies a release package externally. It builds the Web app, both bundle sets and both packages (`--no-build` uses what is on disk), then checks the release fuses, the app.asar contents against the verified bundles, the remote debugging refusal (with the test package as positive control), a startup and SIGTERM quit (`taskkill` on Windows) on a fresh user data directory, and signing. On Windows the startup check also requires the cookie key writer to have stored and checked the key exactly once, with no warning or failure record (measured on Windows 11 arm64: stored in 120 to 130 ms and checked); elsewhere it requires no cookie key lines. A failed startup reports the app's last main-process log lines, the kinds of process still running and the end of stderr. On macOS the startup check is skipped (exit 2) while the screen is locked, and the first launch of a freshly written package is slower than later ones (measured 1.8–2.0 s against 0.5 s). It prints one pass, fail or skipped line per check and exits 0 when verified, 1 when a check failed and 2 when incomplete. For a native Windows distribution, keep the generated per-architecture SHA-256 receipt next to the installer when verifying with `--no-build`. It ties the separately signed installer to the checked executable and app.asar. Signing is skipped for a local package and required on macOS and Windows with `--distribution`. Linux skips this check. On Linux hosts where the sandbox cannot start it skips the two launching checks (exit 2) unless `--allow-no-sandbox` runs them with `--no-sandbox`.

`pnpm start:desktop` opens the packaged release app with the arguments you supply. It uses the installed app's normal user data, credential store and single-instance lock by default. To isolate a manual check, supply a fresh `"--user-data-dir=<absolute path>"` and, on macOS, `--use-mock-keychain` or, on Linux, `--password-store=basic`. On Linux the launcher reports a blocked Chromium sandbox and exits 1 before starting the app.

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

### Real-app benchmark

```bash
pnpm build:desktop:test
pnpm --filter desktop bench --rounds 5 --measure-ms 10000 --warmup-ms 2000
pnpm --filter desktop bench compare bench-results/<file>.jsonl
```

The benchmark runner does not build. It runs the unpackaged test bundles, or a packaged test app with `--app <executable>`; release builds and the dev server have no benchmark. Each record carries the target and fuse readings, and runs that differ in either are never merged or compared. DESKTOP_PORT_ACK_COALESCE=0 disables ACK batching for comparisons; default enables it. `.env.example` documents process environment options; the desktop host does not itself load a .env file. BENCH_VERBOSE passes Chromium stderr through.

## Project identity and imports

`src/main/app-url.ts` owns `APP_SCHEME`, `APP_HOST`, `APP_ORIGIN` and `isAppUrl`. The origin stays `app://app`, independently of product naming and shared `APP_ID`. Separate userData directories isolate applications; changing the origin within an existing directory requires migrating localStorage and IndexedDB.

When deriving an application, set `APP_ID` in `@repo/shared/src/app-identity.ts`, `productName` in this app's `package.json`, and `appId` in `electron-builder.base.yml`. Keep the builder's `productName` equal to package metadata; a test checks this. Change the other distribution placeholders listed above as well.

Electron's default userData is `<appData>/<app.name>`; `app.name` uses `productName` when present, otherwise package `name`. Builder `appId` does not choose that directory. `prefs.json`, `visual-theme.json` and `compile-cache/` retain their filenames within the selected application directory. Development uses `<userData>-dev`; test launches use a fresh `--user-data-dir`.

Here `~/` resolves to `src` in TypeScript and Vite/Vitest. Native Node `scripts/` and `e2e/` can use standalone `import type { ... } from "~/..."`, which is erased; they cannot use runtime alias imports or inline `import { type X }`, which retains an import statement. Runtime sharing across applications goes through workspace packages or the web build package, not relative source paths.

Packaged E2E paths follow the builder's default executable names: macOS uses `<productName>.app/Contents/MacOS/<productName>`, Windows uses `<productName>.exe`, and Linux uses the lowercased package `name` (currently `desktop`), not `productName`. The helper selects the existing architecture-specific output directory. `executableName` overrides are not supported by this template's launcher and are rejected by configuration tests.

Keep both package `name` and `productName` portable for that path helper: an ASCII letter first, then ASCII letters, digits, spaces, dots, underscores or hyphens; no trailing dot/space or Windows reserved filename. The helper validates this constraint instead of approximating electron-builder's filename sanitization. Product names may contain spaces; package names must also satisfy package-manager metadata requirements.

## Diagnostic suites

Runtime window, storage and transport code stays in `src/main`. Benchmark runners and routes live in `src/diagnostics/bench`; smoke runners, layout measurements and routes in `src/diagnostics/smoke`; E2E utility routes in `src/diagnostics/e2e`. `main.ts` and `utility.ts` reach them only through `~/diagnostics/entry.ts`, which release builds replace with `entry.empty.ts`; `main/run-modes.ts` only decides which run is on (benchmark, then smoke, then E2E; no benchmark against the dev server). Debug variables are read only in `src/debug-env.ts`, with names from `src/debug-env.names.ts`.

`DESKTOP_SMOKE=1 pnpm --dir apps/desktop start:test` runs the application suite (bootstrap, transport, styles, window safety and reload/error recovery). It does not require the demo homepage. `DESKTOP_SMOKE=1 DESKTOP_SMOKE_LAYOUT=1 pnpm --dir apps/desktop start:test` additionally runs the template layout fixture matrix against `features/demo`. Template acceptance must explicitly enable this matrix; a requested matrix with missing controls fails rather than silently skipping. The result identifies `suite: application` or `suite: template-layout`. Business projects may delete demo and its route registration and keep the application suite. `test:e2e:host` runs host contracts against the real application root without requiring demo controls; `test:e2e:demo` selects the `@demo` suites in `demo-layout.spec.ts` and `demo-visual.spec.ts`. The full `test:e2e` command includes both and remains required for template acceptance. Derived projects can remove or replace the demo suites without removing host tests.

The layout fixture uses named `data-demo-shell` / `data-demo-header` controls and `data-module-panel-toggle` attributes, independent of control order and translated button labels.
