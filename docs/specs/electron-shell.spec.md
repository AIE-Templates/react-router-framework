# Electron host specification

## Process boundaries (HOST-01)

The desktop host reuses the web client, Hono host and API. Production opens no TCP listener for pages or API. Main owns windows, the dedicated session, protocol mapping, utility lifecycle and restricted system bridges. Sandboxed preload is a single CommonJS file. The utility process runs `createWebApp`, SSR or SPA hosting, static files, API and port-fetch as ESM under Node resolution conditions. The renderer uses the same web client build without Node integration.

Build outputs are `main.cjs`, `preload.cjs` and `utility.mjs`. Main must not import `@repo/server` or top-level await `app.whenReady()`. Shared contracts are browser-safe. Transport packages remain independent of Electron and testable under Node. Electron is pinned in package metadata; upgrades require validation rather than a runtime version allowlist.

## Protocol mapping (HOST-02)

Requests follow `app://app` → dedicated-session protocol handler → internal HTTP URL → MessagePort/port-fetch → utility `createWebApp().fetch(Request)` → streamed response. Register standard, secure, supportFetchAPI, stream, corsEnabled and codeCache privileges before ready. Reject targets outside `app://app`.

The internal origin provides server URL/same-origin semantics, not a listening port. Map URL, relevant Origin/Referer and response Location. Non-GET/HEAD requests receive a trusted internal Origin and Sec-Fetch-Site for Hono CSRF and Router checks. Strip renderer-supplied Cookie and X-Desktop-* before injecting actual host state and preferences. Web hosts remove desktop headers; headers cannot establish desktop identity.

Server redirects use relative paths, including Router `.data` redirects embedded in response bodies. Do not derive public absolute links from internal request URLs. Static files and SPA HTML belong only to the web host. The development proxy uses manual redirects to preserve status and Location.

## Transport and utility lifecycle (HOST-03)

Port-fetch multiplexes request IDs with Request/Response headers, status and bidirectional bodies. Return response streams as soon as headers arrive. Acknowledgement windows bound unconsumed bytes and pause upstream reads. Chunks use standalone Uint8Array buffers so cloning a subarray does not copy a larger backing store. No zero-copy guarantee applies; Electron ports receive no ArrayBuffer transfer list.

Cancellation, timeout, port closure, early response and stream error clean up both ends idempotently. Closed ports reject new requests. Response cancellation reaches the server request signal, which upstream fetches must propagate. Electron may not deliver cancellation before response headers; the desktop path bounds header wait to 60 seconds without applying that limit to SSE/download body duration.

Adapt MessagePortMain event shapes and start semantics, transferring ports only after utility spawn. Utility state is explicitly idle/starting/running/stopping/stopped. Concurrent starts share readiness. Fork-to-ready times out after 20 seconds; shutdown has a 3-second grace period. Shutdown forbids automatic restart. Increasing generations coordinate restart/readiness with window recovery.

## Identity, trust and CSP (HOST-04)

Host identity comes from `createWebApp({ shell })`; development uses WEB_SHELL configuration. Stable shell facts and trusted per-request window/preferences data are distinct. SSR supplies root seeds; SPA reconnects through preload according to the layout lifecycle.

The renderer uses contextIsolation, sandbox and no nodeIntegration. The application has a dedicated persistent session. Navigation and redirects stay on app://app. New windows are denied; external http/https/mailto links go to the system browser. IPC verifies the registered BrowserWindow, its current webContents, current main frame, and frame protocol/host; comparing opaque origin alone is insufficient.

Capture main exceptions in logs instead of blocking default dialogs. Protocol/port failures are explicit. Logs omit credentials, full bootstrap/preferences and sensitive queries. Single-instance locking, utility shutdown and listener cleanup are required. macOS activation can create/register a new window after closure. Desktop identity is not business authorization and never grants arbitrary proxy destinations.

The web host owns CSP. SSR uses one document nonce across React, ServerRouter, Links, ScrollRestoration and Scripts; revalidation cannot replace the active document nonce. Static SPA/prerendered HTML uses hashes, identical for GET/HEAD, and does not serve document ranges. Production script-src excludes unsafe-inline. Inline chrome safety styles require the configured style policy independently of script policy.

## Development and startup (HOST-05)

`pnpm dev:desktop` starts a separate desktop-mode Router dev server and Electron. Pages remain app://; main proxies to development HTTP without running utility. Mapping/trust rules remain the same. Development watches builds, restarts Electron after main/utility changes, reloads after preload changes and waits for the old process to exit. The default port is 5174, configurable with DESKTOP_DEV_PORT; HMR host/clientPort are explicit. Development userData is isolated.

After registering the protocol, ready prepares the hidden window and utility concurrently. Document requests await utility readiness. A trusted preload notification after two animation frames shows the window; ready-to-show has a one-second fallback. Bootstrap enhancement does not gate display. Utility NODE_COMPILE_CACHE resides in userData. Startup evaluation compares repeated same-environment medians and stage timings, not a universal cold-start promise.

## Build and packaging (HOST-06)

Build web first, then the three desktop entries, then electron-builder. Root package:desktop/release:desktop/dist:desktop include builds; package-local packaging scripts consume existing builds. ASAR contains entry bundles and package metadata. Client resources are copied to resources/client and served by utility. Bundled web/server dependencies are not duplicated as runtime node_modules. Only required external native modules belong in dependencies; native modules require Electron ABI and rebuild-policy verification.

Test-profile leaves Fuses unchanged. Release afterPack disables RunAsNode, NodeOptionsEnvironmentVariable and NodeCliInspectArguments; enables CookieEncryption, EmbeddedAsarIntegrityValidation and OnlyLoadAppFromAsar; and reads them back. Release checks run without inspector. Test packages are not hardened release packages.

Configured installer formats are macOS dmg/zip, Windows NSIS and Linux deb/rpm (rpm requires rpmbuild). Signing, notarization, distribution channels and automatic updates are not supplied as completed release services. Linux installation must satisfy sandbox permissions; --no-sandbox is not a default release solution.

## Bidirectional channels (HOST-07)

`@repo/channel` provides MessagePort/WebSocket adapters and relay with ordered delivery, backpressure and bounded connection/queue handling. Producers await whenDrained; send itself does not block or drop frames. Channel is distinct from request/response port-fetch. The template does not expose an application gateway connection, renderer sandbox connection or BFF streaming route merely because the transport package exists.

## Preferences (HOST-08)

Page scripts under app://app cannot read or write cookies. Small client-written, server-read display preferences use a common helper with host-specific storage. Web uses `pref-<key>` cookies with JSON values, percent-encoding characters disallowed in cookie values, Path=/, SameSite=Lax, one-year Max-Age and Secure on HTTPS. Duplicate names use the first, most specific path match. Desktop uses main-process memory and userData/prefs.json, atomically replaced after temporary-file fsync; transient Windows rename failures retry within about 100ms. Values take effect only after successful persistence.

Desktop injects x-desktop-prefs on every request. Preload setPref/removePref invokes validated main IPC. Loader/action `getPreference(context, key)` returns undefined for absent/invalid values. Host context chooses the source: web cookies or desktop request preferences, never an untrusted request-selected mode. `useSetPreference()` writes and revalidates; null deletes; failures reject with PreferenceError/reason. `writePreference(shell, key, value)` works outside React without automatic revalidation. Business code uses these helpers rather than shell branches or direct cookie writes.

There is no general client-side read API for SPA/clientLoader. Supply loader data or design an explicit read bridge when needed. Keys start with a letter and contain letters/digits/underscore/dot/hyphen, at most 64 characters. Values are strings of at most 1024 UTF-16 units, finite numbers or booleans. Both hosts enforce both 4096-byte aggregate limits: ASCII JSON with non-ASCII escaped, and the encoded pref-* cookie header including separators. Oversized updates reject before writing; deletion is always accepted.

Preferences are user-controlled display settings, never credentials, sessions, authorization inputs or bulk data. High-frequency changes persist on commit rather than every frame. Main is the final validator. Invalid requests return rejected without changes; disk failure returns persist-failed with the previous value intact. Malformed files become empty and invalid entries are discarded. Logs omit preference values. Browser desktop-header spoofing is stripped before trusted injection.

## Server cookies (HOST-09)

Main owns server Set-Cookie/Cookie round trips for both utility and development proxy paths because app:// and protocol-handler responses do not receive native network cookie handling. Server/web code retains ordinary cookie semantics. The dedicated session stores host-only cookies using `https://app.desktop`, matching the internal host but permitting Secure storage. Release CookieEncryption protects persistence.

Parse all Set-Cookie fields in order, complete writes/deletions and flushStore before returning the response; remove Set-Cookie before renderer delivery. Replace any renderer Cookie header with stored cookies matching the request path, longest Path first. Read failure logs a warning and continues without cookies. Pure parsing/serialization lives in cookie-jar.ts; Electron adapters own storage.

| Rule          | Desktop behavior                                                                                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain        | Accept only the internal host (also the dev server host during development), ignoring case/leading dot; store host-only; reject other domains                                                                                           |
| Path          | Use an absolute supplied path or the request default directory; enforce browser path matching                                                                                                                                           |
| Expiration    | Max-Age takes precedence over Expires; cap lifetime at 400 days; nonpositive Max-Age/past Expires deletes; invalid expiration leaves a session cookie                                                                                   |
| Secure        | Use HTTPS storage to support Secure cookies                                                                                                                                                                                             |
| HttpOnly      | Parse the flag for prefix validation; store all cookies as HttpOnly so a later replacement can overwrite an existing HttpOnly cookie; page scripts cannot access any cookie                                                             |
| SameSite      | Store the attribute but do not filter sending by it; all application requests attach matching cookies. Reject None without Secure. If third-party frames are explicitly permitted, rely on Origin/CSRF checks for cross-site navigation |
| Prefixes      | Case-insensitive: __Secure- requires Secure; __Host- additionally forbids Domain and requires explicit Path=/; __Http- requires Secure and HttpOnly; __Host-Http- combines both rules                                                   |
| Limits        | Name plus value at most 4096 bytes; ignore attributes over 1024 bytes; process at most 50 cookies per response                                                                                                                          |
| Invalid input | Ignore control characters and nameless cookies; log bounded rejection metadata without values                                                                                                                                           |

Any mutation flushes before response delivery, including replacing persistent cookies with session cookies so stale disk values cannot reappear. Before quit, flush in parallel with utility shutdown with a two-second bound. Session cookies survive reload/window reopening but not process restart. Persistent cookies survive restart.

Cookies attach only to app:// handler upstream requests, never arbitrary targets. Code must not request the storage origin in the application session. The .desktop suffix is not a reserved TLD; future delegation would create a risk if such network requests were allowed. The renderer remains restricted to app://app and CSP does not allow that storage origin. Logs omit Cookie/Set-Cookie contents.

E2E routes mount only with DESKTOP_E2E=1 in unpackaged/test-profile applications. Release ignores that flag with a warning; release self-checks remain available. Page document.cookie stays empty. All app requests are same-origin and attach cookies regardless of fetch credentials mode. Nameless cookies are unsupported. Development and release userData/cookies are isolated.

## Verification requirements

Check real SSR/SPA pages, API, CSP, navigation, redirects, streaming/backpressure/cancellation, bounded lifecycle/recovery, rejected navigation/IPC/header spoofing, preferences and cookie persistence. Verify development reload/restart, packaged resources and release Fuses. Use DESKTOP_SMOKE for machine-readable self-checks; its SSE check covers transport rather than an application SSE feature. Playwright covers unpackaged/test-profile behavior. Installer, sandbox, signing and distribution checks belong to the actual release configuration.
