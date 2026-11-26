# Fullstack host and API specification

## Server and host composition (SRV-01)

`@repo/server` is a Hono API service usable both standalone under native Node (`server.ts`, `startServer()`) and in-process by a host (`createServerApp`). Its source must run directly on native Node with erasable TypeScript: explicit `.ts` relative imports, `process.env` rather than `import.meta.env`, and no enums, namespaces, parameter properties or React Router dependency.

Host composition lives in `apps/web/src/host`: `app.ts` combines `createServerApp` with React Router as `createHostApp`, `web-app.ts` adds static assets and SPA fallback as `createWebApp`, `vite-plugin.ts` adapts development and prerendering, and `server.ts` is the native Node production entry only. Host middleware extends the same Hono application chain before Router fallback rather than wrapping it in a second Hono app, preserving a single request-ID, logging and error chain.

In SSR mode, `createHostApp` registers cache protection after `extend?.(app)` and around the Router fallback. Every dynamically served HTML document and Router `.data` response gets `Cache-Control: private, no-store`. Loaders can use request credentials even when the visual cookie is missing. Desktop SSR uses the same visual request cookie as Web SSR. Trusted desktop headers still seed window facts and generic preferences. The static SPA shell, prerendered HTML, and prerendered `.data` files are served earlier with `Cache-Control: no-cache` so they can revalidate. SPA mode omits the SSR cache middleware.

API route chains live in `packages/server/src/routes/` and mount under `/api` in `src/api.ts` so `ApiType` retains full inference. Unknown `/api/*` paths return JSON 404. Workspace consumers resolve source via the `@repo/source` export condition while external consumers use `dist`; keep both export targets synchronized and keep one Hono version across all packages.

## In-process BFF and security boundaries (SRV-02)

Application and browser code imports only server types through `@repo/server/types`; host code and host integration tests may import implementations. Server loaders and actions call `context.get(apiContext)` in-process; browser code and client data APIs use `~/lib/api`. In-process calls forward caller credentials (`cookie`, `authorization`), request ID and `AbortSignal`. Pass `request.signal` and `c.req.raw.signal` to upstream fetches.

CSRF protects browser API mutations (`Origin`, JSON content type, and explicit `ALLOWED_ORIGINS` for credentialed cross-origin clients). Because in-process calls bypass API CSRF, mutations must live in Router actions (which enforce Router origin checks), never in loaders reachable from cross-site navigation.

Host identity comes from entry configuration (`createWebApp({ shell })`), never request headers. Only trust forwarded protocol and host headers when `TRUST_PROXY` is explicitly enabled behind a trusted TLS-terminating proxy. Server redirects stay relative; an embedded host's internal request URL is not a public origin.

## Content Security Policy (SRV-03)

The web host owns CSP (`apps/web/src/host/csp.ts`), configurable through `createWebApp` and `createHostApp` (or `false` to disable deliberately). Production `script-src` excludes `unsafe-inline`; development permits Vite and HMR under its own policy. Cross-origin API destinations must be added to `connect-src`.

SSR generates one per-document nonce shared across `ServerRouter`, React streaming, `Links`, `ScrollRestoration` and `Scripts`. Both hydration sides receive the same nonce prop; root revalidation must not replace the active document nonce, and root error rendering recovers it from the document. Static SPA and prerendered HTML derive `sha256` content hashes for inline scripts; `GET` and `HEAD` return identical CSP headers, and document byte ranges are disabled.

## Streaming, deferred errors and logging (SRV-04)

Wrap deferred loader promises in `logRejection` with `loggerContext` and `request.signal`, because Router `handleError` does not capture unhandled deferred rejections. Hono `stream`, `streamText` and `streamSSE` callbacks must use `rethrowNonErrors()` and `logStreamFailure(c)` instead of default console logging.

Log structured data first through `c.var.logger` or `context.get(loggerContext)`, never `console`, credentials or complete query strings. Expected 4xx responses and caller cancellation are not unhandled errors; stream timing measures time to first byte. Development-only behavior checks `NODE_ENV === "development"`; unset `NODE_ENV` uses production defaults.

## Environment and deployment (SRV-05)

Load `.env` only in `react-router.config.ts` (development and build) and `server.ts` (production start); existing process variables take precedence and `${VAR}` expansion is supported. Preserve `dotenv` 17.x and `dotenv-expand` 13.x alignment with Vite; command substitution in newer expand versions requires explicit review. Only `VITE_*` enters browser bundles; never commit `.env` files.

`createWebApp` and `createHostApp` default to the rendering mode compiled from the Router configuration. `createWebApp({ ssr })` passes the selected mode to `createHostApp` and registers the SPA shell handler when `ssr` is false. Static assets are cached and compressed; HTML documents and API responses are left uncompressed for proxies or CDNs so streaming HTML is not buffered. Start production Node directly (`node apps/web/server.ts` or `node packages/server/server.ts`) so `startServer()` receives shutdown signals. Build Docker images from the workspace root so workspace dependencies are available, running the deployed process as a nonprivileged user.
