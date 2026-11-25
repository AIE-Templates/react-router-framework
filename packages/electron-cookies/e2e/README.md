# Server cookie E2E

From the workspace root, on a graphical host with Electron 45 and `openssl` on PATH:

```sh
pnpm --dir packages/electron-cookies test:e2e
```

The command compiles the fixture and the package sources it imports with TypeScript into
`dist/e2e/fixture`, then runs Playwright's Electron driver. It uses the package's Electron executable.
The first launch needs that executable installed or available in Electron's download cache.
The list reporter prints the Electron and Chromium versions. Each test result also includes a
`process.versions` attachment. Set `COOKIE_FIXTURE_SCHEME` to exercise a different scheme.

Each test generates a profile and a one-day self-signed certificate. Only the hard-kill test
reopens that profile. Chromium trusts the generated public key for this launch. Resolver rules
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
Partitioned identity and invalid UTF-8 are compared on the wire.

| Spec                   | Coverage                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `differential.spec.ts` | SRV-01, 02, 03, 03a, 03b and 06. Field parsing and storage, nameless cookies, partitioned collisions, byte and path boundaries, clock skew.                                                      |
| `server.spec.ts`       | SRV-04, 05 and 08. HttpOnly downgrade ordering and concurrent real-store reads, domain identity in dev and production, HMR handshake, path deletion, hard-kill persistence and timeout recovery. |
| `initiator.spec.ts`    | SRV-09. Main-process loads, app workers, opaque sandbox frames and foreign initiators.                                                                                                           |
