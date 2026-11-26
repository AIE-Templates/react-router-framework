# Electron cookie E2E

From the workspace root, on a graphical host with Electron 45 and `openssl` on PATH:

```sh
pnpm --dir packages/electron-cookies test:e2e
```

The command compiles the fixture main and worker with TypeScript and bundles the sandbox preload with Rolldown into
`dist/e2e/fixture`, then runs Playwright's Electron driver. It uses the package's Electron executable.
The first launch needs that executable installed or available in Electron's download cache.
The list reporter prints the Electron and Chromium versions. Each test result also includes a
`process.versions` attachment. Set `COOKIE_FIXTURE_SCHEME` to exercise a different scheme.

Each test generates a profile and a one-day self-signed certificate. The clean-quit and hard-kill restart tests
reopen their respective profiles. Chromium trusts the generated public key for this launch. Resolver rules
point `cookie.test` and `localhost` at loopback, with proxying disabled. The HTTP and HTTPS
servers bind to random ports on 127.0.0.1 and use the same handler. Test-controlled responses
issue individual Set-Cookie fields and an optional Date, and echo the incoming Cookie bytes.
The two malformed control-byte responses use fixed raw HTTP fields and a lenient loopback
reader on the jar side so they can also reach the parser.

The privileged scheme defaults to `fixture://app`. Its handler forwards GET requests to the
HTTP server, calls the package's jar with the real path, headers, signal and initiator, waits
for response cookie storage, and strips Set-Cookie before returning the response.
The jar uses the profile's persistent Chromium store under `https://app.desktop`.
Native requests go through Chromium's HTTP stack. Playwright inspects records in the main
process and normalizes only the site hostname, preserving the domain-cookie leading dot.
Partitioned identity and invalid UTF-8 are compared on the wire. The same sandboxed preload runs in
main and subframes with context isolation. Only the fixture origin installs the package's shims.
Window tests compare page values, Cookie Store errors and change events with Electron's native pages.
The HTTPS ordinary domain supplies the reference for domain cookies, since localhost is single-label.

| Spec                               | Coverage                                                                                                                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clear-site-data.spec.ts`          | Native Clear-Site-Data on navigation and fetch, wildcard and malformed lists, same-response Set-Cookie, storage-host isolation, and window and worker events for clearing and HttpOnly replacement.                                                 |
| `differential.spec.ts`             | SRV-01/02/03/03a/03b/04/06, DC-03 and CS-06/08. Stored fields, nameless cookies, partitioned identity, wire bytes including a leading BOM, URL-derived default paths, equal-path order within a response, response Date clock skew.                 |
| `server.spec.ts`                   | SRV-04, 05 and 08. HttpOnly downgrade ordering and concurrent real-store reads, domain identity in dev and production, HMR handshake, path deletion, hard-kill persistence and timeout recovery.                                                    |
| `initiator.spec.ts`                | SRV-07/09. Main-process loads, dedicated and shared worker credentials, opaque sandbox frames and foreign initiators.                                                                                                                               |
| `document-cookie.spec.ts`          | DC-01–12, 14–15, 17/17a, 24 and CS-15. Script writes, attributes and paths, restart, partition and domain identity, UTF-8.                                                                                                                          |
| `cookie-store.spec.ts`             | CS-01–13 and DC-13. Structured queries, error details, store synchronization, event contents and listener delivery.                                                                                                                                 |
| `frames.spec.ts`                   | DC-18, 20–23, 25. Inherited cookie URLs, opaque and foreign frames, blob and about:blank. DC-23 also uses the desktop source guard.                                                                                                                 |
| `credentials.spec.ts`              | SRV-07 (window) and DC-25. Pins the known differences for manifest links, credentials-omit module workers and Cache.add/put on app://. Marker at protocol entry, headers and methods at the HTTP(S) server, argument conversion and fetch failures. |
| `store-outage.spec.ts`             | DC-16/16a/16b and CS-14. A store gate checks synchronous/async deadlines, cooldown and snapshot refresh. The network service crash test uses POSIX signals.                                                                                         |
| `redirects.spec.ts`                | SRV-07. Set-Cookie on 302/303/307 for fetch and navigation, manual redirects, the omit marker across same-origin and cross-origin redirects.                                                                                                        |
| `requests.spec.ts`                 | SRV-08/09. Non-2xx Set-Cookie, FormData, Blob and streamed bodies, keepalive, XHR, forms, images, scripts and EventSource.                                                                                                                          |
| `cookie-store-identity.spec.ts`    | CS-11/13, SW-12c. Native CookieStore identity in windows and workers, event trust, listeners borrowed from other realms.                                                                                                                            |
| `service-worker.spec.ts`           | SW-01–07, SW-14, SRV-07/09 (worker). Script-URL reads, URL resolution, subscriptions and cookiechange contents against a native worker.                                                                                                             |
| `service-worker-lifecycle.spec.ts` | SW-08–13. Wake after stop and restart, hard kills, re-registration, updates, waitUntil keepalive across a real idle-termination window (slow, about 90 s) and timeouts, notification ordering, lost unregister holders.                             |

DC-19 exercises the real desktop capability bridge and first-paint IPC in `apps/desktop/e2e/storage.spec.ts`.
