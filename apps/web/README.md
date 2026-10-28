# Web application

React Router framework mode with shared workspace tooling, Tailwind CSS, Vitest and Testing Library. Source lives in src/app; `~/` resolves there.

Run `pnpm dev` at the workspace root for HMR at http://localhost:5173. Build with `pnpm --filter web build`. See the root README for the available commands.

## Rendering

SSR is the default. Set SSR=false for an SPA build; application route exports must be compatible. Server loaders/actions/middleware/headers (except the build-time root loader) and non-root HydrateFallback prevent SPA builds. Client data APIs can work in both modes, with a first-render skeleton followed by browser data loading.

## Host and API

Hono runs pages and @repo/server in the same process. src/host/app.ts composes createHostApp; web-app.ts adds static files and SPA fallback as createWebApp; vite-plugin.ts adapts development/prerendering; testing.ts provides createTestContext. server.ts is only the native Node production entry. API lives under /api.

Loaders/actions call context.get(apiContext); browser/client data APIs use api from ~/lib/api. Import only server types through @repo/server/types in application/browser code. In-process calls forward credentials, request ID and AbortSignal; pass the signal to upstream fetches. Mutations belong in actions because in-process API calls bypass CSRF. Deferred loader promises use logRejection with loggerContext and request.signal. Integrated tests use createTestContext; route components may use createRoutesStub.

Each request passes through one logging/error/request-ID chain. Use context.get(loggerContext) or c.var.logger. Stream timing is time to first byte; expected 4xx and caller cancellation are not unhandled errors. Cross-origin action rejection logs a bounded warning. Production defaults apply when NODE_ENV is absent.

## CSP

SSR has one per-document nonce shared by ServerRouter, React streaming, Links, ScrollRestoration and Scripts. Both hydration sides use the same nonce prop. Root revalidation must not replace the active document nonce; root error rendering recovers it from the document. Static SPA/prerendered documents use content hashes for inline scripts; GET/HEAD policies match and document ranges are disabled. Production script-src excludes unsafe-inline. Development permits Vite/HMR using its own policy. Configure csp in createWebApp/createHostApp, or false to disable it deliberately. Add cross-origin API destinations to connect-src.

## Environment and deployment

Copy .env.example for local configuration. Router config loads it for dev/build; server.ts loads it for start. Existing variables take priority and ${VAR} expansion is supported. Restart dev after edits. Only VITE_* enters browser bundles; native server code uses process.env. HOST/PORT default to 0.0.0.0/3000, LOG_LEVEL to debug in development and warn in production. Enable TRUST_PROXY only behind a trusted TLS-terminating proxy supplying forwarded protocol/host.

Run pnpm build then node apps/web/server.ts, or the configured start script. Deploy build, server.ts, package.json and production dependencies with pnpm deploy. Start Node directly in production to receive signals. The host chooses SSR/SPA from the built server export, not runtime SSR configuration. Static assets are cached/compressed; documents and API are left to the proxy/CDN for compression so streaming HTML is not buffered. Prerendered HTML/data revalidate; SPA deep links use __spa-fallback.html when present, otherwise index.html.

createWebApp returns a Hono app with standard Request/Response fetch semantics for embedding. clientDir can locate external static resources. External React, Router, Hono, node adapter and pino versions must match the web package. Heavy SSR shares the host event loop; use a worker/utility process when isolation is needed. Build Docker from the workspace root using apps/web/Dockerfile; the deployed Node process runs as a nonprivileged user.

For separate static/client hosting, build with VITE_API_ORIGIN and list the client origin in the server's ALLOWED_ORIGINS for credentialed requests. Server redirects are relative; an embedded host's internal request URL is not a public origin.
