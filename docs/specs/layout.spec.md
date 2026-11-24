# Application layout specification

## Scope and ownership (LAY-01)

An **app area** is a top-level part of the product selected by the route. For example, Chat and Code are separate areas. Opening another conversation changes the view within Chat.

| Layer           | React component                   | Responsibility                                                                                                                                  |
| --------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| App Root        | `AppRoot`                         | Provides the host environment, manages the runtime connection and composes global providers inside the root `Layout`.                           |
| App Shell       | `BasicShell` or `NavigationShell` | Frames the current area and composes the window chrome. `NavigationShell` adds application navigation. A single-area app can omit the switcher. |
| App Area Layout | `AppAreaLayout`                   | Arranges one area's main content, optional sidebar and optional auxiliary panel. The sidebar can host navigation within the area.               |

`areaId` identifies an area definition and must be unique among layouts rendered on the same page. The caller owns preferences that persist across mounts. Business providers own themes, sessions and organization state. When the URL identifies the current organization, it is authoritative.

Core defines host-neutral shell and window-chrome contracts. Hosts supply environment seeds and implement native window operations. Area components delegate native geometry, platform policy and window IPC to the shell and host.

## Environment and rendering (LAY-02)

The same lifecycle applies to web and desktop in both rendering modes.

- **First render.** SSR uses trusted host context. A static SPA starts with the build-time web seed. Hydration must match the initial HTML. Rendering does not access the bridge or wait for desktop enhancement.
- **After mount.** `AppRoot` connects to the optional preload bridge. A validated bootstrap supplies the effective desktop identity and chrome mode. Root revalidation cannot overwrite them. A desktop seed mismatch reports the differing field names only. A web seed can resolve to a desktop host.
- **Unavailable enhancement.** A missing bridge, invalid bootstrap or failed connection leaves the safety layout available. Document attributes mirror the runtime state. Host identity is independent of viewport size and input characteristics. Only the host can grant desktop capabilities.
- **Disconnect.** Cleanup applies only to its own connection and is idempotent. Disconnect releases subscriptions and appearance ownership, clears dynamic window state and marks the connection unavailable. A reconnected shell can declare its appearance again.

Unknown routes return HTTP 404 under SSR. A static SPA hydrates the root fallback before its wildcard client loader raises a 404 for the route error boundary.

## Component contracts (LAY-03)

| Component         | Contract                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppRoot`         | Requires `children`. Accepts initial `shell`, `mode`, `fullscreen` and `managersInitialState`. Components access the environment and window operations through `useAppEnvironment()` and `useWindowChrome()`. |
| `BasicShell`      | Requires `children`. Accepts `headerMode`, `overlayAppearance`, and standalone title-bar `title` and `actions`.                                                                                               |
| `NavigationShell` | Adds required `navigation` and optional `navigationLabel` (landmark name, default `Primary`). The narrow-screen trigger reads `App navigation`.                                                               |
| `AppAreaLayout`   | Requires `areaId`, `title` and `children`. Accepts header `actions`, `sidebar` / `sidebarTitle`, `auxiliary` / `auxiliaryTitle`, and `contentAs`. Omitted panels occupy no column.                            |

Navigation, sidebar and auxiliary panel states are independent. In controlled mode the callback requests a change and the caller supplies the new value. Uncontrolled state defaults to closed.

| Region                        | Controlled value | Initial value           | Change callback          |
| ----------------------------- | ---------------- | ----------------------- | ------------------------ |
| Application navigation drawer | `navigationOpen` | `defaultNavigationOpen` | `onNavigationOpenChange` |
| Area sidebar                  | `sidebarOpen`    | `defaultSidebarOpen`    | `onSidebarOpenChange`    |
| Area auxiliary panel          | `auxiliaryOpen`  | `defaultAuxiliaryOpen`  | `onAuxiliaryOpenChange`  |

These focus rules apply to area panels in both inline and drawer layouts, and to the application drawer. On a closed-to-open transition, the panel attempts to focus its first focusable control. Initially open panels leave focus in place. The close button and an unhandled Escape originating inside the panel request closure and return focus to its trigger when focusable. An Escape handled by a descendant with `preventDefault()` leaves the panel open. Panels are non-modal and allow focus to leave.

Each page supplies one `main` landmark. Set `contentAs="main"` on one area layout or supply the landmark in the page. Other layout content containers use the default `div`.

## Shell and title bar composition (LAY-04)

Both shells support `headerMode="fused"` (default) and `"standalone"`, independently of area count and viewport width.

- **Standalone.** The shell renders a separate title bar above the area. Area headers below it do not drag the window.
- **Fused.** An `AppAreaLayout` directly inside `.shell-body` can contribute its column headers to the window's top band. Each inline header retains its own content and background. Floating panel headers do not drag.

Use `getDragRegionProps()` for draggable surfaces and `getInteractiveProps()` for interactive content in a drag region. Apply the interactive marker to the actual surface of a portal.

Window Controls Overlay (WCO) reports physical coordinates. Each visible top column reserves the portion of the native controls' inset that overlaps it, accounting for LTR/RTL, open panels and navigation width. On macOS, when the navigation rail is narrower than the native button group, its links start below the safe band and the adjacent header reserves the remaining inset. Only the shell declares native overlay appearance for the layout. The host validates requests and applies supported values without measuring area DOM elements.

## Persistent safety boundary (LAY-05)

The root `Layout` renders `.root-chrome-fallback` outside the route content, on normal pages, during hydration, and on error pages including 404s. Inline CSS resets document margins and preserves the fallback height, scroll boundaries and title-bar handoff when external styles or business JavaScript are unavailable.

The fallback reserves `--app-window-safe-top` in normal flow. This equals the top offset of the WCO rectangle plus its height, with zero defaults when the environment variables are absent. The fallback drag surface must use the reported width and height and the physical left offset in both LTR and RTL. Fallback geometry depends only on WCO environment variables, which can also be present in a web app.

A shell is eligible for handoff when its diagnostic is absent or `host-mismatch`. The fallback yields only when an eligible shell directly inside `.root-content` supplies a complete top band. Standalone mode uses the title-bar content. In fused mode, `AppAreaLayout` sets `data-chrome-complete` from the shell context. Inline CSS checks for the main column header on that direct path. Without it, the fallback stays in flow. A wrapper that breaks the direct-child path, or a portal outside that path, cannot trigger handoff. Removing a participating element or setting its `hidden` attribute restores the fallback in the same style calculation when no other qualifying band remains. A shell hidden by custom CSS must also use `hidden` or withdraw its participation marker.

The top band stays in the viewport while content scrolls. Refresh and renderer reload use the same safety boundary. A desktop SPA may shift once from the fallback to its fused frame after hydration. Renderer process failure is handled by the host.

## Sizing, scrolling and responsiveness (LAY-06)

**Panel placement.** Open area panels respond to the area's container width. Above a viewport width of `48em`, application navigation is a persistent rail regardless of `navigationOpen`. At or below `48em`, that state controls drawer visibility. Changing width preserves the open states.

| Area width                | Sidebar | Auxiliary panel |
| ------------------------- | ------- | --------------- |
| Up to and including 40rem | Drawer  | Drawer          |
| Above 40rem through 60rem | Inline  | Drawer          |
| Above 60rem               | Inline  | Inline          |

Area drawers begin below the main content header, including when actions wrap. In either header mode, the navigation drawer aligns below the first directly composed area's main header, even when its actions wrap. This alignment requires an area header. Resizing must preserve business state. Layouts with both device safe-area insets and window controls must account for each independently.

**Header sizing.** Area headers have a minimum height of `--app-layout-header-height` (default `3rem`). Window headers use `--app-window-header-height`, which defaults to the layout header height. A participating window band accommodates the larger of that minimum and the WCO safe height. On Windows in `native-overlay` mode, the band adds a 1 CSS px bottom separator. A 48px minimum with a safe height of 48px or less gives a 49px minimum band. This applies to fused inline headers, the navigation drag band and standalone title bars. The separator is outside the native overlay height. Wrapping can increase the rendered header height without requesting a taller native overlay. macOS uses the host's own height policy.

In a title row shared with native controls, long titles must truncate visually while retaining their full DOM text. Actions must remain reachable when they wrap. Content must remain reachable at larger text sizes, with an explicit scroll container for each pane and no unintended horizontal or document overflow.

**Scroll restoration.** React Router handles window scroll. `ContentScrollRestoration` tracks `.root-content` and marked panes by history key, falling back to the URL path, query and fragment for the default key. The current document keeps up to 100 entries. A history traversal restores saved positions. Other navigations reset panes to the origin, except that a fragment-only change preserves existing pane offsets before bringing its target into view. Saved positions take precedence over the fragment on traversal. The initial fragment may resolve when the hydration fallback is replaced. Reloading clears the saved positions.

## Acceptance checks

Exercise both shell variants and both header modes across web/desktop and SSR/SPA. Check LTR and RTL at each panel breakpoint, drawer focus and dismissal, and scroll restoration through back/forward navigation. Verify that native controls remain accessible on first paint, on reload, without external styles or business JavaScript, and while transitioning into and out of error pages. Opening and closing a portal must preserve control interaction and restore dragging underneath it.
