# Web application

React Router framework mode with shared workspace tooling, Tailwind CSS, Vitest and Testing Library. Source lives in src/app; `~/` resolves there.

Run `pnpm dev` at the workspace root for HMR at http://localhost:5173. Build with `pnpm --filter web build`. See the root README for the available commands.

## Rendering

SSR is the default. Set SSR=false for an SPA build; application route exports must be compatible. Server loaders/actions/middleware/headers (except the build-time root loader) and non-root HydrateFallback prevent SPA builds. Client data APIs can work in both modes, with a first-render skeleton followed by browser data loading.

Use the configured start command to serve the build through react-router-serve. Run Docker builds from the workspace root.

## Layout

AppRoot owns environment/providers; BasicShell or NavigationShell owns application framing; ModuleLayout owns its workspace/panels. The home route demonstrates ?shell=basic and ?header=standalone. Safety CSS stays inline in root Layout, outside route success/failure. It requires the default style-src unsafe-inline allowance; a stricter policy needs a hash. See docs/specs/layout.spec.md for contracts.
