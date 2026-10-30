# Application layout specification

## Scope and ownership (LAY-01)

The layout has three responsibility boundaries. `AppRoot` owns the effective environment, runtime lifecycle and global provider composition. `AppShell` owns application navigation, module placement and window chrome composition. `ModuleLayout` owns its workspace, optional sidebar and auxiliary panel, and module-scoped layout state. A single-module application still uses an application shell; it may omit navigation.

Modules must not branch on operating systems, estimate native button geometry or call window IPC. Route state determines the current module. Business providers own themes, sessions and organizations; do not duplicate an authoritative organization already encoded in the URL. Layout state is separate from business state. `moduleId` identifies a module definition, not a permanent instance identity. Unmounting releases subscriptions and temporary resources; persistence belongs to the caller.

## Environment and rendering (LAY-02)

Host identity, input/display characteristics and layout size are independent. A narrow Electron window remains a desktop host. User agents and request parameters cannot grant desktop capabilities.

SSR seeds the environment from trusted host context. SPA root loaders run at build time, so their web identity is not the final runtime identity. Initial hydration must match the server or static HTML; rendering must not call the bridge. After mounting, `AppRoot` attempts preload bootstrap even when the initial identity is web. A valid bootstrap takes precedence; later root revalidation cannot overwrite it with an older seed. Desktop SSR mismatches expose field names only. A build-time web to runtime desktop transition in SPA is expected.

Components read `useAppEnvironment()`. Document attributes mirror that state and are not another authority. A normal browser without a bridge remains web. Invalid bootstrap or bridge failure reports unavailable enhancement while retaining safe layout. Authorization remains in the host.

Web SSR, web SPA, desktop SSR and desktop SPA share this lifecycle. SPA unknown paths report 404 through a wildcard/client loader after root fallback hydration; SSR retains HTTP 404. Enhancement readiness must not delay showing the first document.

## Component contracts (LAY-03)

- `AppRoot` remains mounted in the root Layout and manages the runtime. Inputs are optional shell, mode and fullscreen seeds plus children.
- `useAppEnvironment()`, `useWindowChrome()`, `getDragRegionProps()` and `getInteractiveProps()` are the React environment bindings.
- `BasicShell` accepts children and optional `title`, `actions`, `headerMode` and `overlayAppearance`.
- `NavigationShell` adds `navigation`, `navigationLabel`, controlled `navigationOpen`, `defaultNavigationOpen` and `onNavigationOpenChange`.
- `ModuleLayout` accepts `moduleId`, `title`, children, actions, sidebar/sidebarTitle and auxiliary/auxiliaryTitle.

Each module panel supports controlled open state, an uncontrolled default and a change callback. Uncontrolled panels default to closed. Callbacks do not implicitly persist preferences. Application navigation and module sidebar state are independent. Opening a panel attempts to focus an interactive descendant; closing restores the trigger. Escape closes only the panel containing the event target. These panels are not modal dialogs with complete focus traps.

Pages own accessible region labels and module composition.

## Shell and title bar composition (LAY-04)

Both shells support `headerMode: "fused" | "standalone"`, defaulting to fused. Shell choice, module count, header composition and responsive size are independent.

Standalone mode supplies a separate top row; lower module headers do not drag the window. In fused mode, module headers participate in the top window frame in place, preserving each column's content and background. The shell assigns constraints and participation; it does not collect business UI in a global store. A fused `ModuleLayout` must be a direct layout child of `.shell-body`. Unknown wrappers retain the root safety fallback.

Visible columns distribute WCO physical coordinates rather than applying full-window insets to every column. Translate RTL logical edges into physical left/right edges. Panel closure, drawer presentation and navigation collapse must still cover every native control safety area. On macOS, navigation too narrow for the traffic lights begins below the safe band and adjacent headers cover the remaining inset.

The application shell is the sole overlay appearance writer. Modules must not use DOM measurements to drive native height. Window modes and platform heights follow the window chrome specification where a desktop host is present.

## Persistent safety boundary (LAY-05)

The root Layout keeps `.root-chrome-fallback` outside route children, including normal pages, hydration fallback, root errors and 404. Critical safety CSS is inline: margin reset, nonshrinking flex geometry, scrolling boundaries and fused handoff rules must survive missing external styles.

`--window-safe-top` is `titlebar-area-y + titlebar-area-height`, defaulting to zero. The fallback occupies this height in normal flow; its drag rectangle uses WCO x, width and height without covering native controls. Geometry does not depend on `data-shell`, providers or bootstrap. WCO variables can also exist in a web application; zero fallback values are not evidence that native controls are absent.

Only directly composed, visible top regions that cover the complete constraints may hide the fallback through structural markers and `:has()`. Arbitrary descendants, portals, hidden headers or partial regions cannot trigger handoff. Unmounting or hiding participating content/ancestors with `hidden` restores the fallback in the same style calculation. Custom hiding mechanisms must update composition markers explicitly.

The top interaction band stays in the viewport while body content scrolls. Safety must hold before hydration, without business JavaScript, on refresh and renderer reload. Renderer process failure belongs to host recovery. Desktop SPA may make one controlled layout shift from fallback to fused chrome without a new display gate.

## Sizing, scrolling and responsiveness (LAY-06)

AppShell allocates the application area; modules respond to their allocated container space. Each scrolling region has one explicit owner.

Ordinary headers use `--shell-header-height: 3rem` (48 CSS px at the default font size). Window headers use `--window-header-height`, inheriting that value. A larger WCO safe area increases layout height; Windows headers are not shrunk to the reported WCO height.

Windows native-overlay uses a 48px body plus a separate 1px bottom separator, totaling 49px by default. Fused column headers, navigation drag bands and standalone title bars share this rule; lower business headers and floating headers do not add this separator. Borders do not contribute to native overlay height. macOS keeps its own height policy.

Larger text and wrapping content must remain accessible. A title sharing the native-control row truncates visually with an ellipsis while preserving its full DOM text; actionable controls wrap instead of being clipped. Grid/flex children must shrink, have explicit scroll ownership and avoid accidental horizontal overflow or nested body scrolling.

| Module container width     | Panel presentation                                |
| -------------------------- | ------------------------------------------------- |
| At most 40rem              | Sidebar and auxiliary panel are drawers           |
| Above 40rem, at most 60rem | Sidebar can be inline; auxiliary remains a drawer |
| Above 60rem                | Sidebar, workspace and auxiliary can be inline    |

Application navigation becomes a drawer at a viewport width of at most 48rem. These are configurable layout defaults, not device identities. Responsive changes must not recreate business state. Device safe areas and WCO constraints are distinct inputs and must be combined deliberately.

## Required behavior

Verify both shells and header modes, all host/render combinations, LTR/RTL, wide and narrow containers, independent panel state, keyboard focus, errors and 404 recovery. Missing business JavaScript or external styles must leave minimum safe geometry intact. Portal surfaces remain interactive and restore underlying drag behavior when closed.
