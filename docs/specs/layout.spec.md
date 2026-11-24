# Application layout specification

## Scope and ownership (LAY-01)

This specification describes how application pages are laid out. An **app area** is a top-level division of the UI within the app shell. One area can contain every page in the application. When the design calls for multiple areas, the shell hosts the area switcher.

In the CRM demo, the single-area layout groups Leads, Deals and Sales report in one sidebar. The multi-area layout groups Leads and Deals under Sales and places the sales report under Reports. Switching layouts keeps the same pages and route paths.

| Layer           | React component                   | Responsibility                                                                                                                                |
| --------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| App Root        | `AppRoot`                         | Provides the host environment, manages the runtime connection and composes global providers inside the root `Layout`.                         |
| App Shell       | `BasicShell` or `NavigationShell` | Frames the current area and composes the window chrome. `NavigationShell` hosts the area switcher. Use `BasicShell` for a single-area layout. |
| App Area Layout | `AppAreaLayout`                   | Arranges one area's main content, optional sidebar and optional auxiliary panel. The sidebar can host navigation within the area.             |

`areaId` is shared by routes in the same area and must be unique among layouts rendered on the same page. The caller stores any layout preferences that must survive unmounting. Application providers manage themes, sessions and organization state. If the URL identifies the current organization, use it as the source of truth.

The shared application layer defines the shell and window-chrome interfaces. Each host supplies initial environment values and implements native window operations. The shell and host handle native button geometry, platform differences and window IPC for all areas.

## Environment and rendering (LAY-02)

Web and desktop follow the same rules for SSR and SPA rendering.

- **First render.** SSR uses trusted host context. A static SPA starts with the build-time web seed. Hydration must match the initial HTML. Rendering does not access the bridge or wait for desktop enhancement.
- **After mount.** `AppRoot` connects to the preload bridge if one is present. A validated bootstrap supplies the effective desktop identity and chrome mode. Root revalidation cannot overwrite them. If the bootstrap disagrees with a desktop seed, the runtime reports `host-mismatch` and lists only the differing field names. A web seed can resolve to a desktop host.
- **Bridge unavailable.** If the bridge is missing, the bootstrap is invalid or the connection fails, the root layout still reserves space for the window controls (LAY-05).
- **Disconnect.** Cleanup applies only to its own connection and is idempotent. Disconnect releases subscriptions and appearance ownership, clears dynamic window state and marks the connection unavailable. A reconnected shell can declare its appearance again.

Document attributes mirror the runtime state. Viewport size and input characteristics do not determine host identity. Only the host can grant desktop capabilities.

Unknown routes return HTTP 404 under SSR. A static SPA hydrates the root route's `HydrateFallback` before its wildcard client loader raises a 404 for the route error boundary.

## Component contracts (LAY-03)

| Component         | Contract                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppRoot`         | Requires `children`. Accepts initial `shell`, `mode`, `fullscreen` and `managersInitialState`. Components access the environment and window operations through `useAppEnvironment()` and `useWindowChrome()`. |
| `BasicShell`      | Requires `children`. Accepts `headerMode`, `overlayAppearance`, and standalone title-bar `title` and `actions`.                                                                                               |
| `NavigationShell` | Adds required `navigation` and optional `navigationLabel` (landmark name, default `App areas`). The narrow-screen trigger reads `Switch area`.                                                                |
| `AppAreaLayout`   | Requires `areaId`, `title` and `children`. Accepts header `actions`, `sidebar` / `sidebarTitle`, `auxiliary` / `auxiliaryTitle`, and `contentAs`. Omitted panels occupy no column.                            |

Navigation, sidebar and auxiliary panel states are independent. In controlled mode the callback requests a change and the caller supplies the new value. Uncontrolled state defaults to closed.

| Region               | Controlled value | Initial value           | Change callback          |
| -------------------- | ---------------- | ----------------------- | ------------------------ |
| Area switcher drawer | `navigationOpen` | `defaultNavigationOpen` | `onNavigationOpenChange` |
| Area sidebar         | `sidebarOpen`    | `defaultSidebarOpen`    | `onSidebarOpenChange`    |
| Area auxiliary panel | `auxiliaryOpen`  | `defaultAuxiliaryOpen`  | `onAuxiliaryOpenChange`  |

Area panels (inline or drawer) and the area switcher drawer are non-modal. They allow focus to leave.

- Opening a closed panel moves focus to its first focusable control, if possible. A panel that starts open leaves focus in place.
- The close button or an unhandled `Escape` inside the panel requests closure and focuses the trigger if it can receive focus. If a descendant calls `preventDefault()` on `Escape`, the panel stays open.

Each page supplies one `main` landmark. Set `contentAs="main"` on one area layout or supply the landmark in the page. Other layout content containers use the default `div`.

## Shell and title bar composition (LAY-04)

Both shells support `headerMode="fused"` (default) and `"standalone"`, independently of area count and viewport width.

- **Standalone.** The shell renders a separate title bar above the area. Area headers below it do not drag the window.
- **Fused.** An `AppAreaLayout` directly inside `.shell-body` can contribute its column headers to the window's top band. Each inline header retains its own content and background. Drawer headers do not drag the window.

Use `getDragRegionProps()` for draggable surfaces and `getInteractiveProps()` for interactive content in a drag region. For a portal, apply the interactive marker to the rendered popup surface.

Window Controls Overlay (WCO) reports physical coordinates. Each visible top column reserves the portion of the native controls' inset that overlaps it, accounting for LTR/RTL, open panels and navigation width. On macOS, when the navigation rail is narrower than the native button group, its links start below the safe band and the adjacent header reserves the remaining inset. Only the shell declares native overlay appearance for the layout. The host validates requests and applies supported values without measuring area DOM elements.

## Persistent safety boundary (LAY-05)

The root `Layout` renders `.root-chrome-fallback` outside the route content, on normal pages, during hydration, and on error pages including 404s. Inline CSS resets document margins and preserves the fallback height, scroll boundaries and title-bar handoff when external styles or application JavaScript are unavailable.

The fallback reserves `--app-window-safe-top` in normal flow. This equals the top offset of the WCO rectangle plus its height, with zero defaults when the environment variables are absent. In both LTR and RTL, position the fallback drag surface from the physical left edge using the WCO rectangle's offset, width and height. Fallback geometry depends only on WCO environment variables, which can also be present in a web app.

Inline CSS hides the fallback when the shell is a direct child of `.root-content`, carries `data-chrome-ready`, and provides a visible title bar in one of these forms:

- **Standalone.** The required path is `.app-shell > .shell-titlebar > .shell-titlebar-content`.
- **Fused.** The main column header is present in the directly composed area layout. `AppAreaLayout` sets `data-chrome-complete` from the shell context.

The shell sets `data-chrome-ready` when its diagnostic is absent or equals `host-mismatch`. An intervening wrapper breaks the required path. A portal outside the path cannot supply the title bar. If the last qualifying title bar or a participating ancestor is removed or marked `hidden`, CSS restores the fallback in the same style calculation. Code that hides the shell through custom CSS must also set `hidden` or remove its readiness marker.

The top band stays in the viewport while content scrolls. Refresh and renderer reload use the same safety boundary. A desktop SPA may shift once from the fallback to its fused frame after hydration. Renderer process failure is handled by the host.

## Sizing, scrolling and responsiveness (LAY-06)

**Panel placement.** Open area panels respond to the area's container width. Above a viewport width of `48em`, the area switcher is a persistent rail regardless of `navigationOpen`. At or below `48em`, that state controls drawer visibility. Changing width preserves the open states.

| Area width                | Sidebar | Auxiliary panel |
| ------------------------- | ------- | --------------- |
| Up to and including 40rem | Drawer  | Drawer          |
| Above 40rem through 60rem | Inline  | Drawer          |
| Above 60rem               | Inline  | Inline          |

Area drawers open below the main content header. In both header modes, the area switcher drawer aligns with the bottom of the first directly composed area's main header when one is present. Both follow the rendered header height when actions wrap. Crossing a breakpoint must preserve application state, including an unsaved draft in the current area. Layouts that use device safe-area insets as well as WCO must account for both.

In fused mode, the persistent rail reserves the window header band for native-overlay windows. Other hosts reserve only the inset reported by WCO (zero in a regular browser tab). The navigation drawer and the rail below a standalone title bar need no additional band.

**Header sizing.** Area headers have a minimum height of `--app-layout-header-height` (default `3rem`). Window headers use `--app-window-header-height`, which defaults to the layout header height. A participating window band accommodates the larger of that minimum and the WCO safe height. On Windows in `native-overlay` mode, the band adds a 1 CSS px bottom separator. A 48px minimum with a safe height of 48px or less gives a 49px minimum band. This applies to fused inline headers, the navigation drag band and standalone title bars. The separator is outside the native overlay height. Wrapping can increase the rendered header height without requesting a taller native overlay. macOS uses the host's own height policy.

In a title row shared with native controls, long titles must truncate visually while retaining their full DOM text. Actions must remain reachable when they wrap. Content must remain reachable at larger text sizes, with an explicit scroll container for each pane and no unintended horizontal or document overflow.

**Scroll restoration.** React Router handles the window. `ContentScrollRestoration` tracks `.root-content` and marked panes separately. It stores up to 100 entries per document, indexed by history key. When the key is `"default"`, it uses the URL path, query and fragment together. Reloading clears them.

On back or forward navigation, saved offsets take precedence over a fragment target. Without saved offsets, panes start at the origin unless only the fragment changed. For a fragment-only change, panes keep their offsets before the target scrolls into view. On initial load, fragment scrolling can wait for hydration to replace the fallback with the target.

## Acceptance checks

Exercise both shell variants and both header modes across web/desktop and SSR/SPA. Check LTR and RTL at each panel breakpoint, drawer focus and dismissal, and scroll restoration through back/forward navigation. Verify that native controls remain accessible on first paint, on reload, without external styles or application JavaScript, and while transitioning into and out of error pages. Opening and closing a portal must preserve control interaction and restore dragging underneath it.
