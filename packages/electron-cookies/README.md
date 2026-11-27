# @repo/electron-cookies

For one custom-scheme origin, server Set-Cookie and script cookie APIs share an Electron session's store. Windows use `document.cookie` and `cookieStore`. Service workers use `cookieStore`. The host owns scheme registration, protocol handling, URL mapping, header shaping and window creation. This private workspace package has Electron as a peer dependency. Its source, unit tests and Electron fixture are self-contained for extraction.

## Public interface

The three subpath exports provide built JavaScript and declarations, with `@repo/source` selecting TypeScript source in the workspace.

| Export      | Interface                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./main`    | `createCookieJar(options)` returns `cookieHeader(request, signal?)`, `storeResponseCookies(headers, request)` and the script adapter used by IPC. `installCookieIpc(options)` serves windows. `installCookieWorkerIpc(options)` serves workers and returns a handle with `quitAll()`. `flushForQuit(store, log)` bounds the final flush. `CookieStoreLookupError` identifies a failed request lookup, including its timeout subclass `CookieStoreTimeoutError`. |
| `./preload` | `installWindowCookiePreload(options)` and `installServiceWorkerCookiePreload(options)` install the applicable APIs through the sandboxed preload. Lower-level exports include `prepareCookieFrame`, `selectCookieInstallation` and the serializable `installCookieShims`.                                                                                                                                                                                       |
| `./shared`  | `cookieIpcChannels(prefix)`, `OMIT_COOKIES_HEADER` and the IPC contracts, including `CookieReply`, `CookieIpcError`, `WindowCookie`, `CookiePush` and `WorkerCookieEvent`. Use the same prefix in main and preload.                                                                                                                                                                                                                                             |

Configure the jar with the public host and either its origin or its registered scheme (the origin is then `scheme://host`; an explicit origin wins), a private HTTPS storage origin such as `https://app.invalid` for the `app` scheme, the upstream hostname and the application session's cookies. Set `secureScheme` to the registered scheme’s `secure` privilege so trustworthy responses can clear jar cookies (defaults to false). Keep the storage origin fixed across environments and never request it in this session. Supply a session factory and permission-policy callback for the lazy in-memory HttpOnly replacement probe. The logger implements `debug(fields, message)` and `warn(fields, message)`. Optional `timeoutMs` bounds a protocol lookup or response batch (default five seconds).

With cookie encryption enabled, the first store access can outlast `timeoutMs` while macOS prompts for keychain access after a signature change or Linux unlocks a keyring. Before loading the first window, read `session.cookies.get({ url: storageOrigin })`. Desktop retries every two seconds so a read stranded by a network-service restart cannot hold up a ready store. It opens on the first answer and allows up to three minutes for the prompt. [Desktop first-window implementation](../../apps/desktop/src/main/first-window.ts)

IPC takes the application URL predicate, a webContents ownership check and the session's cookie change source. Worker IPC additionally needs that session's serviceWorkers and a `WakeStorage` adapter. Its synchronous `read()` returns wake records at startup. Its asynchronous `write(records)` atomically replaces the complete index. Optional `quitTimeoutMs` bounds how long `quitAll()` waits for wake-index finalization (default 2,000 ms); at the deadline main warns and quit proceeds, an in-flight atomic write may still finish and queued writes are discarded. Optional `wakeTimeoutMs` bounds each `startWorkerForScope()` call (default 60,000 ms, Chromium's startup limit for an installed Service Worker); a timeout uses the scope's retry schedule and a worker returned after the deadline gets nothing from that attempt. Optional `taskTimeoutMs` bounds each event's keepalive from send until acknowledgement, including pending `waitUntil` promises (default five minutes, matching Chromium's request timeout). Chromium keeps the actual subscriptions in `registration.cookies`.

A subscription waits up to five seconds for its wake-index write, including time in the write queue. A timeout rejects the subscribe before it reaches Chromium. Further subscribes can retry after the outstanding writes settle. A successful native unsubscribe or unregister immediately updates in-memory delivery eligibility and keeps its native result if cleanup fails. Main retries cleanup with the latest index and flushes outstanding changes on clean quit. A forced exit during a storage failure can leave old wake hints on disk.

## Desktop wiring

Register the scheme before ready with standard, secure, allowServiceWorkers, supportFetchAPI, stream, corsEnabled and codeCache privileges. After ready, install the application session's permission policy and wire IPC before loading windows. The desktop host supplies the origin constants, registry, logger and storage callbacks used below.

```ts
import {
  createCookieJar,
  installCookieIpc,
  installCookieWorkerIpc,
  stripCookieMarkers,
  type CookieIpcOptions,
} from "@repo/electron-cookies/main";

const appSession = session.fromPartition("persist:app");
installPermissionPolicy(appSession, log);
const cookies = createCookieJar({
  host: APP_HOST,
  secureScheme: true,
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

In the application protocol handler, pass the pathname, Electron's initiatorOrigin and the original request headers to both jar methods. Call `stripCookieMarkers(headers)` on the mutable upstream headers so the omit marker never reaches the upstream; the desktop host also strips incoming Cookie and untrusted x-desktop-* headers before adding trusted host fields.

```ts
const cookieRequest = { path: pathname, initiatorOrigin: request.initiatorOrigin, headers: request.headers };
stripCookieMarkers(headers);
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

A rejected or timed-out `cookieHeader` lookup fails the request before it reaches the upstream. Desktop returns 503 with Retry-After for subresources and a transport error for main-document recovery. Strip Set-Cookie before delivering the response. After windows accept quit, await `workers.quitAll()` and `flushForQuit(appSession.cookies, log)` alongside host shutdown. The desktop wake index lives in userData/cookie-wake-index.json.

## Behavior and compatibility

- Main sends matching cookies and accepts Set-Cookie only for browser-initiated requests (absent initiatorOrigin) or the application origin, and only without the omit marker. Window and service worker fetch wrappers set or clear that marker for application requests according to the effective credentials mode. Same-origin no-cors, dedicated workers, shared workers and about:blank frames can lose omit semantics. Opaque frames receive no jar cookies, even with include.
- On eligible navigation and subresource responses, an ASCII Clear-Site-Data list containing `"cookies"` or `"*"` clears the private host’s host-only and domain cookies on every path, including HttpOnly. Chromium suppresses Set-Cookie when the same response has either HTTP list token. The jar flushes deletions before delivery. Window and worker events report only script-visible deletions. The jar implements only the cookie portion of site-data clearing.
- Server writes preserve HttpOnly. Scripts can read and write non-HttpOnly cookies, including valid nameless cookies. Document writes parse text and silently ignore rejected cookies. Cookie Store validates structured arguments and rejects invalid writes. Only server response batches explicitly flush before delivery. Concurrent batches that downgrade HttpOnly on overlapping cookie identities can interleave. Old cookies keep their stored flags.
- Window cookie access uses the document creation URL, including across history changes and when another same-origin window's accessor or CookieStore method is applied to the document. Such a borrowed CookieStore method rejects argument-validation failures in the method's window; once the call reaches storage, its promise and any storage error (such as a refused HttpOnly overwrite) belong to the receiving store's window, as in Chromium. Same-origin srcdoc inherits the parent's recorded URL when available. Same-origin blob: and srcdoc without a recorded parent URL retain native cookie APIs and registration methods and receive only the fetch wrapper. Initial and navigated about:blank frames lack preload and jar-cookie inheritance. During a store failure, synchronous reads can return a stale per-URL snapshot or the empty string.
- Explicit script Domain equal to the public host creates a domain cookie even on a single-label host. Partitioned requires Secure but shares ordinary identity, deletion and eviction limits. Cookie Store reports partitioned=false. Server fields with invalid UTF-8 are dropped. Cookie Store TypeError stacks refer to the shim, and fetch rejection messages can refer to Request construction.
- Visible changes reach matching window documents as change events. Main uses the persisted wake index to find service workers by cookie name and path. The active worker checks native subscriptions before dispatching cookiechange. Each event has an independent waitUntil lifetime bounded at five minutes. Events are synthetic (isTrusted=false). Changes during subscribe can be delivered. Removal outside wrapped unregister can leave stale eligibility at a reused scope. Electron 45 gives the same error for missing registrations and transient wake failures. Each scope queues at most 128 waiting changes (oldest dropped first) and shares one wake schedule: an immediate attempt and retries after 100, 400 and 1,600 ms. A change whose worker dies or whose send fails before `started` is retried as the oldest waiting change. After the last failure main warns, drops the queue and retains the index; the next matching change tries again. Three exhausted schedules in a row make a scope's hints dormant until it subscribes again. Each subscribe accepts up to 128 entries and names up to 4,096 bytes; the index holds up to 256 subscriptions per scope and 128 scopes. Successful wrapped unregister clears it. Closing a window releases its change registrations.
- Other custom schemes do not participate. Multiple cookie-bearing custom-scheme sites and using protocol.handle to intercept HTTP(S) are unsupported. Direct HTTP(S) requests use Chromium's native cookies.

The native comparison baseline is Electron 45.0.0 / Chromium 156.0.8078.48. Rerun the differential suite and review the compatibility boundaries on upgrade. The desktop contract includes the complete request-source policy and known differences. [HOST-09](../../docs/specs/electron-shell.spec.md#server-cookies-host-09)

## Tests

Run from the workspace root. The E2E command builds its own Electron fixture and requires a graphical host, the installed Electron binary and openssl on PATH. The fixture records process.versions and compares the custom scheme with native HTTP(S). [E2E fixture and coverage](e2e/README.md)

```sh
pnpm exec vitest run --project electron-cookies
pnpm --dir packages/electron-cookies test:e2e
```
