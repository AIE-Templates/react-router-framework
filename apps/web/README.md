# Web application

React Router framework mode with shared workspace tooling, Tailwind CSS, Vitest and Testing Library. Source lives in src/app; `~/` resolves there.

Run `pnpm dev` at the workspace root for HMR at http://localhost:5173. Build with `pnpm --filter web build`. See the root README for the available commands.

## Static deployment

This branch builds a static SPA (ssr: false). Deploy build/client to static hosting; development still uses the Router dev server. Configure deep-link fallback to __spa-fallback.html when prerendering supplies it, otherwise index.html. Serve assets as files and let the client router resolve routes. Use the supplied Docker configuration for static hosting. Server loaders/actions are not available; the root loader runs only at build time.

### Development dependency optimization

`future.unstable_optimizeDeps` lets React Router supply Vite with the client entry and route modules as dependency scanning inputs. It reduces late discovery when a route first imports a dependency. It does not change production data loading or revalidation. The flag is experimental in React Router 8.5; recheck it on upgrades. If it causes dependency optimization errors, remove the flag and restart development.

Validate with a forced dependency scan. This branch always builds a SPA; the SSR/SPA choice belongs to the Base and Fullstack templates:

```sh
pnpm --filter web exec react-router dev --force --host 127.0.0.1 --port 5173 --strictPort
```

Use an isolated browser. Check the first page hydrates, route changes and reloads work, HMR still connects, and no failed module requests or page errors appear. `--force` forces Vite dependency optimization; a warm-page reload alone does not validate cold startup. This is a development compatibility check, not a measured claim about production startup speed.

### Route discovery and revalidation

This static branch uses initial route discovery; do not force lazy discovery here. SSR templates keep React Router's default lazy route discovery. It sends the initially matched route metadata and discovers other paths through `/__manifest`; rendered links normally start discovery ahead of a click. Large route tables benefit from the smaller initial manifest. For small apps with frequent programmatic navigations to new dynamic paths, consider `routeDiscovery: { mode: "initial" }` in `react-router.config.ts`. This sends all route metadata initially, while route code remains split. SPA already uses initial discovery; do not force lazy discovery there.

Compare initial document size and first visits to new dynamic paths before choosing. Manifest discovery, server-loader `.data` requests and application API calls are separate costs; changing discovery does not eliminate loader requests.

The server root loader runs at build time in this static branch; runtime data refresh belongs to client loaders. Keep default revalidation. A custom `shouldRevalidate` defines the freshness contract of its own loader, including explicit refreshes and mutations. Equal current/next URLs are not an explicit-refresh signal: `revalidate()` during a pending navigation targets the destination URL. If optimizing a known navigation with `defaultShouldRevalidate: false`, check every reused loader affected by that call, not just root. Keep dynamic identity and resource invalidation explicit.

## Source organization

`src/app/routes.ts` maps URLs to feature route modules (`features/<name>/<page>.route.tsx`). The disposable home example lives in `features/demo`; removing its route registration and directory removes `/`. `features/main` holds the SPA 404. The root document remains in `root.tsx`.

Global CSS enters through `styles/index.css`. Prefer colocated CSS Modules in the `components` cascade layer; Tailwind utilities remain available. Use `~/` for app-root imports and `./` within a directory or its children. See the root and directory-level AGENTS.md files for conventions.
