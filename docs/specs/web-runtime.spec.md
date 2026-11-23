# Web runtime and engineering specification

## Rendering modes (WEB-01)

This static branch builds in SPA mode (`ssr: false` in `apps/web/react-router.config.ts`) and ignores `SSR`. Application route exports must stay compatible with static SPA builds (plus optional `prerender` paths).

SPA builds reject non-root server loaders, server actions, middleware, route headers and non-root `HydrateFallback`. The root loader runs at build time without a live user request. Components, `meta`, `links`, `ErrorBoundary` and client data APIs provide the static shell with browser data loading.

In development, `future.unstable_optimizeDeps` lets React Router supply Vite with the client entry and route modules for cold-start dependency scanning. It does not change production data loading or revalidation and must be rechecked on React Router upgrades.

## Route discovery and revalidation (WEB-02)

Static SPA builds always use initial route discovery; do not force lazy discovery (`/__manifest`) here.

Keep default root revalidation. A custom `shouldRevalidate` defines the freshness contract of its own loader, including explicit refreshes and mutations. Never treat `currentUrl === nextUrl` as an explicit-refresh signal: `revalidate()` during an in-flight navigation targets the destination URL. Before opting out with `defaultShouldRevalidate: false`, check every reused loader affected by that navigation and keep dynamic identity and resource invalidation explicit.

## Async result ownership (WEB-03)

Async results belong to the resource, identity and operation that started them. Propagate cancellation (`AbortSignal`) where supported and recheck ownership (active identity and monotonically increasing operation sequence) after every `await` before publishing state, writing persistent storage or navigating.

Invalidate old owners before clearing owned caches on replacement, logout or disposal. Checking only whether a component is mounted is insufficient because a still-mounted component can switch resources. Keep lifecycle and sequence state inside a per-owner controller, never an SSR module singleton. Do not suppress errors from the current owner.

Persistent writes already started require ordering or transaction handling, and aborting a request does not undo a server mutation. Before navigating after a mutation, also check the initiating resource/path and whether a newer navigation is pending.

## Testing and fault injection (WEB-04)

Colocate unit tests with their source as `*.test.ts(x)`; host-dependent integration tests belong to `src/host` when that layer exists. Use `createRoutesStub` when components need Router context and invoke loaders and actions directly.

Inject failures at a narrow external boundary in isolated tests, preserve the real component or provider path, and assert recovery after removing the fault as well as the failure state. Always restore injections in `finally`. Use deterministic gates (such as deferred promises) rather than fixed sleeps to test out-of-order completion, cancellation and disposal races.
