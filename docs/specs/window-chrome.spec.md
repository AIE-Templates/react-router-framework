# Window chrome specification

## Ownership

The host owns window policy, native state and appearance writes. A narrow bridge exposes those facts; the framework-independent runtime reconciles them; React consumes the runtime; CSS handles browser geometry. DOM observations must not be promoted to native maximized or fullscreen facts.

## Window policy (CHR-01)

Resolve policy before window creation and record requested mode, resolved mode and any fallback reason. macOS, Windows and Linux default to `native-overlay`. Explicit `system-decorated` retains the system title bar. Reserved `custom-controls` falls back to system-decorated with `custom-controls-not-implemented`; unsupported platforms use `unsupported-platform`.

Unrecognized or missing `DESKTOP_CHROME_MODE` requests the default. There is no OS, architecture or Electron-version allowlist. Mode is fixed for the window lifetime; changing configuration affects the next window. System decoration retains desktop identity and other legitimate bridge capabilities. Recovery does not switch decoration modes.

## Appearance and height (CHR-02)

| Platform         | Native-overlay configuration                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| macOS            | Hidden title bar, overlay height 48; preserve native traffic-light size and horizontal placement; no custom trafficLightPosition |
| Windows          | Hidden title bar and overlay height 48; web content 48 CSS px plus a separate 1px divider                                        |
| Linux            | Hidden title bar and overlay height 36; web header defaults to 3rem and respects WCO geometry                                    |
| System-decorated | No custom titleBarStyle or overlay; title bar remains outside page content                                                       |

These alignment values assume default fonts and 100% page zoom. Electron API units must not be equated with zoomed CSS pixels. Do not rescale WCO/DOM coordinates using display scale or derive viewport coordinates by simply dividing screen DIP by page zoom.

The versioned `visual-theme.json` mirror supplies the initial theme preference. Explicit `dark` or `light` selects colors; `auto`, missing or invalid data follows `nativeTheme`. Generic preferences do not supply the theme. Dark color/symbolColor defaults are `#17191d`/`#f3f4f6`; light defaults are `#ffffff`/`#202124`. Desktop environment/session strings are diagnostic hints, not proof that Chromium uses Wayland. Native theme/button parity is not guaranteed across every Linux or macOS configuration.

## Runtime contract (CHR-03)

Shared contracts are browser-safe with no Node or Electron runtime dependency. Bootstrap version 1 contains desktop shell identity and resolved chrome mode. Only implemented native-overlay and system-decorated modes are accepted. Native fullscreen is distinct from the web Fullscreen API.

Window state contains monotonically increasing `revision`, `focused`, `maximized` and `fullscreen`. Overlay appearance contains optional `color`, `symbolColor` and `height`; results are applied with accepted appearance, unsupported with reason, or rejected with reason.

`AppEnvironment` contains effective shell, mode, enhancement status (`pending`, `available`, `unavailable`), optional window state, and bounded diagnostics (`invalid-bootstrap`, `host-mismatch`, `bridge-failed`). Missing window state means unknown, not an invented all-false state. Diagnostics reveal differing field names, not full payloads.

The runtime provides `getSnapshot()`, `getServerSnapshot()`, `subscribe(listener)`, `connect(bridge)` and `updateOverlayAppearance(input)`. Subscriptions/connections return cleanup functions. Construction does not access the DOM or call the bridge. Snapshot references remain stable without state changes, supporting `useSyncExternalStore`.

Window revision is a host state sequence, not the whole runtime sequence. Old revisions, previous connection generations and late appearance results must not overwrite a new connection. Reload obtains fresh dynamic state rather than replaying static bootstrap.

## Bridge contract (CHR-04)

The chrome bridge exposes bootstrap, state subscription and appearance updates. It does not expose arbitrary IPC, Electron objects or minimize/maximize/close commands. Platform-specific preference methods are a host concern.

Bootstrap is synchronous immutable creation data, not a synchronous IPC request. The Electron host passes JSON through `--desktop-bootstrap=` in additional arguments. It contains no credentials, dynamic state or geometry. Version 1 limits the argument to 2048 characters, individual OS/session strings to 128, and platform to darwin/win32/linux. Fields are allowlisted; invalid input returns null. Hydration and bootstrap precedence follow the layout specification.

`subscribeWindowState` registers the event listener before requesting current state. It returns unsubscribe and never exposes raw IPC events. Tokens bind subscriptions to the current main document; navigation, renderer exit and window closure revoke old subscriptions. Duplicate callback registrations have independent lifetimes. Removing the final listener releases IPC listeners.

Appearance updates allow only color, symbolColor and height, with at least one valid value. Colors are `#RRGGBB` or `#RRGGBBAA`; height is an integer from 32 through 80. Preload and main both validate. Windows/Linux native-overlay uses `setTitleBarOverlay`; unchanged values do not cause another write. macOS and system-decorated return unsupported. Invalid values/senders or native failure return rejected without changing mode.

The theme layer owns window background and default overlay colors. Appearance writes only change the overlay layer and never change the background. Each missing overlay field inherits the theme default. System or explicit theme changes retain all declared overrides. `declareOverlayAppearance` accepts an owner token, increasing revision and a complete appearance snapshot or null release. Removed fields return to theme defaults; stale revisions and conflicting active owners are rejected. An old owner release cannot clear another owner. A committed main-document navigation clears overrides; cancelled or failed navigation attempts retain the current document state. AppShell is the only appearance owner. Every IPC checks the registered window, current main frame and trusted app URL; lifecycle cleanup invalidates listeners, tokens and asynchronous results.

## Geometry and interaction (CHR-05)

WCO CSS environment variables supply safety geometry. Root fallback and fused handoff follow the layout specification. Do not invent measured button rectangles when geometry is unavailable.

`getDragRegionProps()` adds `data-window-drag`; `getInteractiveProps()` adds `data-window-interactive`, preserving caller props. Drag regions are explicit. Buttons, inputs and portal surfaces require no-drag. A transparent full-window portal root must not erase every drag region. Native drag, double-click, system menu, resize and Snap behavior use the native path rather than JavaScript window-manager emulation.

The browser owns resize, container queries and zoom layout. The host subscribes only to required facts such as focus, maximize and native fullscreen. Correct CSS markers alone do not establish native interaction correctness.

## Recovery (CHR-06)

Both implemented decoration modes use the same bounded recovery coordinator. Main-document load failure or abnormal renderer exit permits at most one automatic reload per failure cycle, coordinated with utility readiness. Further failure offers native Reload/Close. Unresponsive first offers Wait/Reload/Close without automatic reload. Normal navigation cancellation, subframe failure and normal exit are not window failures. Route errors, 404 and bootstrap failure use page fallback rather than host reload.

The reload target must be a validated application document URL, updated by navigation. Before the first successful load use the original valid target, never a blank or external URL. A failure cycle ends after a successful main document remains stable for 30 seconds. Utility-triggered reload consumes the same single automatic allowance; manual retry does not reset it. Utility restart has its own budget.

Recovery waits for utility starting/ready/failed state and generation. Restart and window-error listeners must not reload concurrently. Wait preserves a pending load; retry stops it and invalidates its result before a new load. Window closure, normal exit, changed generation or recovery response invalidates old tasks. Native dialogs introduce no file/data error page, new trusted source or main-process static server. Recovery does not restore renderer memory or detect arbitrary CSS/React failures.
