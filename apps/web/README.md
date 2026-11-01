# Web application

React Router framework mode with shared workspace tooling, Tailwind CSS, Vitest and Testing Library. Source lives in src/app; `~/` resolves there.

Run `pnpm dev` at the workspace root for HMR at http://localhost:5173. Build with `pnpm --filter web build`. See the root README for the available commands.

## Rendering

SSR is the default. Set SSR=false for an SPA build; application route exports must be compatible. Server loaders/actions/middleware/headers (except the build-time root loader) and non-root HydrateFallback prevent SPA builds. Client data APIs can work in both modes, with a first-render skeleton followed by browser data loading.

Use the configured start command to serve the build through react-router-serve. Run Docker builds from the workspace root.

## Layout

AppRoot owns environment/providers; BasicShell or NavigationShell owns application framing; ModuleLayout owns its workspace/panels. The home route demonstrates ?shell=basic and ?header=standalone. Safety CSS stays inline in root Layout, outside route success/failure. It requires the default style-src unsafe-inline allowance; a stricter policy needs a hash. See docs/specs/layout.spec.md for contracts.

## Source organization

`src/app/routes.ts` maps URLs to feature route modules (`features/<name>/<page>.route.tsx`). The disposable home example lives in `features/demo`; removing its route registration and directory removes `/`. `features/main` holds the SPA 404. The root document remains in `root.tsx`.

Global CSS enters through `styles/index.css`. Prefer colocated CSS Modules in the `components` cascade layer; Tailwind utilities remain available. Use `~/` for app-root imports and `./` within a directory or its children. See the root and directory-level AGENTS.md files for conventions.

Core removes starter system-color and background rules from `styles/base.css`: manual visual preferences must win over the OS preference. Core global rules now live in `styles/base.css`, `tokens.css` and `shell.css`; the empty `ui.css` is the UI-library integration slot. `app.css` is retained only as the downstream migration bridge until final cleanup. Demo smoke selectors use `data-demo-controls` and `data-demo-draft`, independently of CSS class names.

## Core development

Read environment through `~/managers/environment/hooks`; interactive and drag DOM props come from `~/managers/environment/dom-props`. The runtime is still created by AppRoot. Reuse `~/components/appearance-settings` for appearance UI. Ordinary component tests may use `renderWithProviders` from `~/testing/render`; route-dependent components still need an explicit Router context, and provider lifecycle tests can mount providers directly.

Colors use Core semantic variables; viewport media widths come from `~/config/breakpoints`. CSS Modules use the components layer. `styles/naming.test.ts` checks real CSS/SCSS and TS/TSX source, including inline CSS strings. The window safety stylesheet stays inline and unlayered in `layouts/app-shell/chrome-safety.ts`.
