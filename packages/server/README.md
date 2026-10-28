# @repo/server

A Hono API service usable standalone or in-process by a host. Define chained routes in `src/routes/` and mount them below `/api` in `src/api.ts` so `ApiType` retains inference. Unknown API paths return JSON 404. `src/app.ts` composes middleware; `server.ts` is the standalone Node entry.

Run `pnpm dev:server` from the workspace for watch mode. Build with `pnpm --filter @repo/server build`; run the deployed service directly with Node so it receives shutdown signals. Build its Dockerfile from the workspace root. `.env.example` documents host, port, logging, proxy trust and allowed browser origins. Existing process variables take precedence; local dotenv expansion supports `${VAR}`. Production platforms should supply environment variables directly.

## Clients and composition

Use the typed client from this package. Application/browser imports are type-only through `@repo/server/types`; host code can import implementation entry points. Workspace consumers resolve source with the `@repo/source` export condition; external consumers use dist. Keep both export targets synchronized. All packages must use the same Hono version for client inference.

The web host supplies an in-process client to Router loaders/actions and forwards caller cookie/authorization headers, request ID and cancellation. Browser clients use fetch. Pass `c.req.raw.signal` to upstream fetches. Use Hono testClient for routes and the web host's createTestContext for integrated loader/action tests.

## Security and logging

CSRF protects browser API mutations. Non-browser clients send JSON or a matching Origin. Explicit ALLOWED_ORIGINS enables credentialed cross-origin clients. In-process calls bypass CSRF, so mutations belong in Router actions, never loaders reachable from cross-site navigation. Enable TRUST_PROXY only behind a trusted proxy supplying forwarded protocol/host; direct clients must not control those facts.

Use `c.var.logger` with structured data first. Every request receives a request ID, preserved by in-process calls. Do not log credentials or complete query strings. Development means `NODE_ENV === "development"`; unset NODE_ENV uses production behavior. Default logging is debug in development, silent in tests and warn otherwise. Streaming helpers use `rethrowNonErrors()` and `logStreamFailure(c)` instead of their default console logging.

## Node runtime

Source must run on native Node with erasable TypeScript: explicit `.ts` relative imports, process.env rather than import.meta.env, and no enums, namespaces or parameter properties. Do not depend on React Router. `startServer()` provides the Node adapter, proxy handling and graceful shutdown. Host middleware extends the same application chain instead of wrapping it in a second Hono app, preserving request IDs, logs and errors.

Keep dotenv 17.x and dotenv-expand 13.x aligned with Vite. Newer command-expansion behavior requires separate review. Never commit `.env` files.
