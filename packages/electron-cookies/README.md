# @repo/electron-cookies

For one custom-scheme origin, server Set-Cookie and script cookie APIs share an Electron session's store. Windows use `document.cookie` and `cookieStore`. Service workers use `cookieStore`. The host owns scheme registration, protocol handling, URL mapping, header shaping and window creation. This private workspace package has Electron as a peer dependency. Its source, unit tests and Electron fixture are self-contained for extraction.

## Public interface

The three subpath exports provide built JavaScript and declarations, with `@repo/source` selecting TypeScript source in the workspace.

| Export      | Interface                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./main`    | `createCookieJar(options)` returns `cookieHeader(request, signal?)`, `storeResponseCookies(headers, request)` and the script adapter used by IPC. `installCookieIpc(options)` serves windows. `installCookieWorkerIpc(options)` serves workers and returns a handle with `quitAll()`. `flushForQuit(store, log)` bounds the final flush. `CookieStoreTimeoutError` identifies a timed-out request lookup. |
| `./preload` | `installWindowCookiePreload(options)` and `installServiceWorkerCookiePreload(options)` install the applicable APIs through the sandboxed preload. Lower-level exports include `prepareCookieFrame`, `selectCookieInstallation` and the serializable `installCookieShims`.                                                                                                                                 |
| `./shared`  | `cookieIpcChannels(prefix)`, `OMIT_COOKIES_HEADER` and the IPC contracts, including `CookieReply`, `CookieIpcError`, `WindowCookie`, `CookiePush` and `WorkerCookieEvent`. Use the same prefix in main and preload.                                                                                                                                                                                       |

Configure the jar with the public scheme, host and origin, a private HTTPS storage origin, the upstream hostname and the application session's cookies. Keep the storage origin fixed across environments and never request it in this session. Supply a session factory and permission-policy callback for the lazy in-memory HttpOnly replacement probe. The logger implements `debug(fields, message)` and `warn(fields, message)`. Optional `timeoutMs` bounds a protocol lookup or response batch (default five seconds).

IPC takes the application URL predicate, a webContents ownership check and the session's cookie change source. Worker IPC additionally needs that session's serviceWorkers and a `WakeStorage` adapter. Its synchronous `read()` returns wake records at startup. Its asynchronous `write(records)` atomically replaces the complete index. Optional `taskTimeoutMs` bounds each event's keepalive from send until acknowledgement, including pending `waitUntil` promises (default five minutes, matching Chromium's request timeout). Chromium keeps the actual subscriptions in `registration.cookies`.

## Desktop wiring

Register the scheme before ready with standard, secure, allowServiceWorkers, supportFetchAPI, stream, corsEnabled and codeCache privileges. After ready, install the application session's permission policy and wire IPC before loading windows. The desktop host supplies the origin constants, registry, logger and storage callbacks used below.

```ts
import {
  createCookieJar,
  installCookieIpc,
  installCookieWorkerIpc,
  type CookieIpcOptions,
} from "@repo/electron-cookies/main";

const appSession = session.fromPartition("persist:app");
installPermissionPolicy(appSession, log);
const cookies = createCookieJar({
  scheme: APP_SCHEME,
  host: APP_HOST,
  origin: APP_ORIGIN,
  storageOrigin: COOKIE_JAR_ORIGIN,
  upstreamHost: new URL(internalOrigin).hostname,
  store: appSession.cookies,
  fromPartition: (partition) => session.fromPartition(partition),
  installPermissionPolicy: (probe) => installPermissionPolicy(probe, log),
  log,
});
const cookieIpc: CookieIpcOptions = {
  jar: cookies,
  prefix: "desktop",
  ipcMain,
  changes: appSession.cookies,
  ownsSender: (sender) => registry.byContentsId(sender.id)?.webContents === sender && sender.session === appSession,
  isAppUrl,
  log,
};
installCookieIpc(cookieIpc);
const workers = installCookieWorkerIpc({
  ...cookieIpc,
  serviceWorkers: appSession.serviceWorkers,
  storage: cookieWakeStorage(app.getPath("userData"), log),
});
appSession.registerPreloadScript({ type: "service-worker", filePath: preloadPath });
```

Use the same bundled preload.cjs for windows, with sandbox, contextIsolation and nodeIntegrationInSubFrames enabled and nodeIntegration disabled. Dispatch at preload entry before application scripts run.

```ts
import { installServiceWorkerCookiePreload, installWindowCookiePreload } from "@repo/electron-cookies/preload";

const options = { appOrigin: APP_ORIGIN, appHost: APP_HOST, prefix: "desktop", ipcRenderer, contextBridge };
if (process.type === "service-worker") {
  installServiceWorkerCookiePreload(options);
} else {
  if (process.isMainFrame) installDesktopBridge();
  installWindowCookiePreload({ ...options, frame: window, isMainFrame: process.isMainFrame });
}
```

In the application protocol handler, pass the pathname, Electron's initiatorOrigin and the original request headers to both jar methods. Forward only the host-shaped headers, which strip incoming Cookie and x-desktop-* before adding trusted host fields.

```ts
const cookieRequest = { path: pathname, initiatorOrigin: request.initiatorOrigin, headers: request.headers };
const cookie = await cookies.cookieHeader(cookieRequest, signal);
signal.throwIfAborted();
if (cookie !== undefined) headers.set("cookie", cookie);
const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
const forwarded = new Request(internalUrl, {
  method: request.method,
  signal,
  headers,
  body: hasBody ? request.body : null,
  ...(hasBody ? { duplex: "half" } : {}),
});
const response = await upstream(forwarded);
await cookies.storeResponseCookies(response.headers, cookieRequest);
```

Strip Set-Cookie before delivering the response. After windows accept quit, await `workers.quitAll()` and `flushForQuit(appSession.cookies, log)` alongside host shutdown. The desktop wake index lives in userData/cookie-wake-index.json.

## Behavior and compatibility

- Main sends matching cookies and accepts Set-Cookie only for browser-initiated requests (absent initiatorOrigin) or the application origin, and only without the omit marker. Window and service worker fetch wrappers set or clear that marker for application requests according to the effective credentials mode. Same-origin no-cors, dedicated workers, shared workers and about:blank frames can lose omit semantics. Opaque frames receive no jar cookies, even with include.
- Server writes preserve HttpOnly. Scripts can read and write non-HttpOnly cookies, including valid nameless cookies. Document writes parse text and silently ignore rejected cookies. Cookie Store validates structured arguments and rejects invalid writes. Only server response batches explicitly flush before delivery. Concurrent batches that downgrade HttpOnly on overlapping cookie identities can interleave. Old cookies keep their stored flags.
- Window cookie access uses the document creation URL, including across history changes. Same-origin srcdoc inherits the parent's recorded URL when available. Same-origin blob: and srcdoc without a recorded parent URL retain native cookie APIs and registration methods and receive only the fetch wrapper. Initial and navigated about:blank frames lack preload and jar-cookie inheritance. During a store failure, synchronous reads can return a stale per-URL snapshot or the empty string.
- Explicit script Domain equal to the public host creates a domain cookie even on a single-label host. Partitioned requires Secure but shares ordinary identity, deletion and eviction limits. Cookie Store reports partitioned=false. Server fields with invalid UTF-8 are dropped. Cookie Store TypeError stacks refer to the shim, and fetch rejection messages can refer to Request construction.
- Visible changes reach matching window documents as change events. Main uses the persisted wake index to find service workers by cookie name and path. The active worker checks native subscriptions before dispatching cookiechange. Each event has an independent waitUntil lifetime bounded at five minutes. Events are synthetic (isTrusted=false). Changes during subscribe can be delivered. Removal outside wrapped unregister can leave stale eligibility at a reused scope. Electron 45 gives the same error for missing registrations and transient wake failures. Each scope queues at most 128 waiting changes (oldest dropped first) and shares one wake schedule: an immediate attempt and retries after 100, 400 and 1,600 ms. After the last failure main warns, drops the queue and retains the index; the next matching change tries again. Successful wrapped unregister clears it. Closing a window releases its change registrations.
- Other custom schemes do not participate. Multiple cookie-bearing custom-scheme sites and using protocol.handle to intercept HTTP(S) are unsupported. Direct HTTP(S) requests use Chromium's native cookies.

The native comparison baseline is Electron 45.0.0 / Chromium 156.0.8078.48. Rerun the differential suite and review the compatibility boundaries on upgrade. The desktop contract includes the complete request-source policy and known differences. [HOST-09](../../docs/specs/electron-shell.spec.md#server-cookies-host-09)

## Tests

Run from the workspace root. The E2E command builds its own Electron fixture and requires a graphical host, the installed Electron binary and openssl on PATH. The fixture records process.versions and compares the custom scheme with native HTTP(S). [E2E fixture and coverage](e2e/README.md)

```sh
pnpm exec vitest run --project electron-cookies
pnpm --dir packages/electron-cookies test:e2e
```
