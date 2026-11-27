# Application layout specification

## Scope and ownership (LAY-01)

The three layers describe how application pages are laid out. An **app area** is the part of the UI that the shell presents as a unit. The product design determines which pages belong together. The same features and routes can share one area or be grouped into several. When the UI offers a choice of areas, the shell hosts the area switcher.

In the CRM demo, Leads, Deals and Sales report share one area in the single-area layout. In the multi-area layout, opening Deals from Leads stays within Sales. Selecting Reports in the shell switches areas and opens the sales report. Both layouts use the same three pages and route paths.

| Layer           | Template implementation           | Responsibility                                                                                                                                            |
| --------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App Root        | Root route `Layout` and `AppRoot` | The root document provides the title-bar fallback. `AppRoot` supplies the host environment, manages the runtime connection and composes global providers. |
| App Shell       | `BasicShell` or `NavigationShell` | Frames the current area and integrates the desktop title bar. `NavigationShell` also hosts the area switcher.                                             |
| App Area Layout | `AppAreaLayout` in the demo       | Organizes the pages, navigation and controls within the current area. Each product can reuse the template component, adapt it or supply its own layout.   |

Application providers manage themes, sessions and organization state. If the URL identifies the current organization, use it as the source of truth.

The shell handles the title bar's layout, drag regions and clearance for native controls. The host supplies the initial environment and implements native window operations and IPC. Pages can supply header content and actions through the layout.

## Environment and rendering (LAY-02)

Web and desktop follow the same rules for SSR and SPA rendering.

- **First render.** SSR uses trusted host context. A static SPA starts with the build-time web seed. Hydration must match the initial HTML. Rendering does not access the bridge or wait for desktop enhancement.
- **After mount.** `AppRoot` connects to the preload bridge if one is present. A validated bootstrap supplies the effective desktop identity and chrome mode. Root revalidation cannot overwrite them. If the bootstrap disagrees with a desktop seed, the runtime reports `host-mismatch` and lists only the differing field names. A web seed can resolve to a desktop host.
- **Bridge unavailable.** If the bridge is missing, the bootstrap is invalid or the connection fails, the root layout still reserves space for the window controls (LAY-05).
- **Disconnect.** Cleanup applies only to its own connection and is idempotent. Disconnect releases subscriptions and appearance ownership, clears dynamic window state and marks the connection unavailable. A reconnected shell can declare its appearance again.

Document attributes mirror the runtime state. Viewport size and input characteristics do not determine host identity. Only the host can grant desktop capabilities.

Unknown routes return HTTP 404 under SSR. A static SPA hydrates the root route's `HydrateFallback` before its wildcard client loader raises a 404 for the route error boundary.

## Component contracts (LAY-03)

| Component         | Contract                                                                                                                                                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppRoot`         | Requires `children`. Accepts initial `shell`, `mode`, `fullscreen` and `managersInitialState`. Components observe the environment and window state through `useAppEnvironment()`.                                                                                             |
| `BasicShell`      | Requires `children`. Accepts `headerMode`, `overlayAppearance`, and standalone title-bar `title` and `actions`.                                                                                                                                                               |
| `NavigationShell` | Adds required `navigation` and optional `navigationLabel` (landmark name, default `App areas`). The narrow-screen trigger reads `Switch area`.                                                                                                                                |
| `AppAreaLayout`   | Requires `areaId`, `title` and `children`. Accepts header `actions`, `sidebar` / `sidebarTitle`, `auxiliary` / `auxiliaryTitle`, and `contentAs`. Omitted panels occupy no column.                                                                                            |
| `WindowLayout`    | Shares grid tracks between column headers and bodies. Define tracks with `columns` or style the grid with `gridClassName`.                                                                                                                                                    |
| `WindowColumn`    | Supplies a `header` and a body for its children. Set `primary` on the visible main column. Use `inWindowBand={false}` for a custom drawer header below the top row. Nested body layouts do not participate in window dragging. Direct `strong` titles truncate in the header. |

Routes that share an `AppAreaLayout` use the same `areaId`. Layouts rendered together must have distinct IDs. The caller stores any layout preferences that must survive unmounting.

The following state props apply to the area switcher in `NavigationShell` and the optional panels in `AppAreaLayout`. The CRM demo calls its auxiliary panel “Inspector”. Navigation, sidebar and auxiliary panel states are independent. In controlled mode the callback requests a change and the caller supplies the new value. Uncontrolled state defaults to closed.

| Region               | Controlled value | Initial value           | Change callback          |
| -------------------- | ---------------- | ----------------------- | ------------------------ |
| Area switcher drawer | `navigationOpen` | `defaultNavigationOpen` | `onNavigationOpenChange` |
| Area sidebar         | `sidebarOpen`    | `defaultSidebarOpen`    | `onSidebarOpenChange`    |
| Area auxiliary panel | `auxiliaryOpen`  | `defaultAuxiliaryOpen`  | `onAuxiliaryOpenChange`  |

The CRM demo controls its sidebar in both layouts. On mount it opens the sidebar when it fits inline and leaves it closed when it would appear as a drawer.

Area panels (inline or drawer) and the area switcher drawer are non-modal. They allow focus to leave.

- Opening a closed panel moves focus to its first focusable control, if possible. A panel that starts open leaves focus in place.
- The close button or an unhandled `Escape` inside the panel requests closure and focuses the trigger if it can receive focus. If a descendant calls `preventDefault()` on `Escape`, the panel stays open.

Each page supplies one `main` landmark. Set `contentAs="main"` on one area layout or supply the landmark in the page. Other layout content containers use the default `div`.

## Shell and title bar composition (LAY-04)

Both shells support `headerMode="fused"` (default) and `"standalone"`, independently of area count and viewport width.

- **Standalone.** The shell renders the complete title bar above its children. A product can supply a custom area layout and use the shell’s title bar directly. The custom layout handles its own sizing, scrolling and main landmark. Headers below the title bar do not drag the window.
- **Fused.** Render a `WindowLayout` directly inside either shell. Its optional `columns` prop accepts CSS grid tracks. When omitted, the layout leaves track sizing to the grid stylesheet or CSS auto-placement. Put a `WindowColumn` in each track and pass its top-row content as `header`. Mark one visible column `primary`. Each column shares its track with the content below it. `AppAreaLayout` uses this contract for its workspace and optional panels. Drawer headers do not drag the window.

Native form controls, links and focusable controls in window headers exclude dragging. Empty toolbar space remains draggable. Mark custom pointer targets and portalled surfaces with `getInteractiveProps()`. Before hydration each fused header reserves the full native insets. After mount the layout subtracts the physical space outside each column using its rendered bounds, including after a position-only change. When the primary header is hidden or removed, secondary headers relinquish the window band. CSS reads the current native insets from WCO throughout.

Use `getDragRegionProps()` for draggable surfaces and `getInteractiveProps()` for interactive content in a drag region. For a portal, apply the interactive marker to the rendered popup surface.

Window Controls Overlay (WCO) reports physical coordinates. Each visible top column reserves the portion of the native controls' inset that overlaps it, accounting for LTR/RTL, open panels and navigation width. On macOS, when the navigation rail is narrower than the native button group, its links start below the safe band and the adjacent header reserves the remaining inset. Each window owns its shell, active area, local panel state and native overlay declaration. Set `overlayAppearance` on that shell to override selected title-bar fields. Omitted fields inherit the current defaults. Removing the declaration restores the latest theme defaults. The host validates requests and applies supported values without measuring area DOM elements.

## Persistent safety boundary (LAY-05)

The root `Layout` renders `.root-chrome-fallback` outside the route content, on normal pages, during hydration, and on error pages including 404s. Inline CSS resets document margins and preserves the fallback height, scroll boundaries and title-bar handoff when external styles or application JavaScript are unavailable.

The fallback reserves `--app-window-safe-top` in normal flow. This equals the top offset of the WCO rectangle plus its height, with zero defaults when the environment variables are absent. In both LTR and RTL, position the fallback drag surface from the physical left edge using the WCO rectangle's offset, width and height. Fallback geometry depends only on WCO environment variables, which can also be present in a web app.

The document reserves the safe area by default. A layout that handles clearance itself sets `data-window-safe-area-owner=""` on its visible surface inside `.root-content`. This marker only releases the document reservation. It supplies neither geometry nor a drag region. Any layout can use it, through wrappers and without a shell. Mark drag and interactive surfaces separately.

The stock standalone shell marks its title-bar content. Its fused layout marks the participating primary header. Both declare ownership when their diagnostic is absent or equals `host-mismatch`. When the last owner is removed or it or an ancestor is marked `hidden`, CSS restores the fallback during the same style calculation. Layouts that hide an owner through other CSS must also set `hidden` or remove the marker. Portals outside the route content cannot claim the reservation.

The top band stays in the viewport while content scrolls. Refresh and renderer reload use the same safety boundary. A desktop SPA may shift once from the fallback to its fused frame after hydration. Renderer process failure is handled by the host.

## Sizing, scrolling and responsiveness (LAY-06)

**Panel placement.** `AppAreaLayout` places its open panels according to its container width. `NavigationShell` places the area switcher according to the viewport. Above a viewport width of `48em`, the area switcher is a persistent rail regardless of `navigationOpen`. At or below `48em`, that state controls drawer visibility. Changing width preserves the open states.

| Area width                | Sidebar | Auxiliary panel |
| ------------------------- | ------- | --------------- |
| Up to and including 40rem | Drawer  | Drawer          |
| Above 40rem through 60rem | Inline  | Drawer          |
| Above 60rem               | Inline  | Inline          |

Area drawers open below the main content header. In both header modes, the area switcher drawer aligns with the bottom of the primary header of the first visible directly composed window layout. Without this anchor the drawer starts at the shell body’s top edge. Both follow the rendered header height when actions wrap. Crossing a breakpoint must preserve application state, including an unsaved draft in the current area. Layouts that use device safe-area insets as well as WCO must account for both.

In fused mode, the persistent rail reserves the window header band for native-overlay windows. Other hosts reserve only the inset reported by WCO (zero in a regular browser tab). The navigation drawer and the rail below a standalone title bar need no additional band.

**Header sizing.** The shell’s optional `headerMinHeight` sets a layout minimum in CSS pixels. The demo sets it to `PRODUCT_HEADER_HEIGHT` (48). The stock fused layout accommodates the larger of this minimum and the WCO safe height. Other layouts choose their own policy. On Windows in `native-overlay` mode, the band adds a 1 CSS px bottom separator. A 48px minimum with a safe height of 48px or less gives a 49px minimum band. This applies to fused inline headers, the navigation drag band and standalone title bars. The separator is outside the native overlay height. Wrapping can increase the rendered header height without requesting a taller native overlay. macOS uses the host's own height policy.

In a title row shared with native controls, long titles must truncate visually while retaining their full DOM text. Actions must remain reachable when they wrap. Content must remain reachable at larger text sizes, with an explicit scroll container for each pane and no unintended horizontal or document overflow.

**Scroll restoration.** React Router handles the window. `ContentScrollRestoration` tracks `.root-content` and marked panes separately. It stores up to 100 entries per document, indexed by history key. When the key is `"default"`, it uses the URL path, query and fragment together. Reloading clears them.

On back or forward navigation, saved offsets take precedence over a fragment target. Without saved offsets, panes start at the origin unless only the fragment changed. For a fragment-only change, panes keep their offsets before the target scrolls into view. On initial load, fragment scrolling can wait for hydration to replace the fallback with the target.

## Acceptance checks

Exercise both shell variants and both header modes across web/desktop and SSR/SPA. Check LTR and RTL at each panel breakpoint, drawer focus and dismissal, and scroll restoration through back/forward navigation. Verify that native controls remain accessible on first paint, on reload, without external styles or application JavaScript, and while transitioning into and out of error pages. Opening and closing a portal must preserve control interaction and restore dragging underneath it.
