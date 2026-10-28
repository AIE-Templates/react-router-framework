# Web application

React Router framework mode with shared workspace tooling, Tailwind CSS, Vitest and Testing Library. Source lives in src/app; `~/` resolves there.

Run `pnpm dev` at the workspace root for HMR at http://localhost:5173. Build with `pnpm --filter web build`. See the root README for the available commands.

## Static deployment

This branch builds a static SPA (ssr: false). Deploy build/client to static hosting; development still uses the Router dev server. Configure deep-link fallback to __spa-fallback.html when prerendering supplies it, otherwise index.html. Serve assets as files and let the client router resolve routes. Use the supplied Docker configuration for static hosting. Server loaders/actions are not available; the root loader runs only at build time.

## Layout

AppRoot owns environment/providers; BasicShell or NavigationShell owns application framing; ModuleLayout owns its workspace/panels. The home route demonstrates ?shell=basic and ?header=standalone. Safety CSS stays inline in root Layout, outside route success/failure. It requires the default style-src unsafe-inline allowance; a stricter policy needs a hash. See docs/specs/layout.spec.md for contracts.
