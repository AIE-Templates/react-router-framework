# Window chrome specification

## Ownership

The host owns window policy, native state and appearance writes. A narrow bridge exposes those facts; the framework-independent runtime reconciles them; React consumes the runtime; CSS handles browser geometry. DOM observations must not be promoted to native maximized or fullscreen facts.

## Window policy (CHR-01)

Resolve policy before window creation and record requested mode, resolved mode and any fallback reason. macOS, Windows and Linux default to `native-overlay`. Explicit `system-decorated` retains the system title bar. Reserved `custom-controls` falls back to system-decorated with `custom-controls-not-implemented`; unsupported platforms use `unsupported-platform`.

Unrecognized or missing `DESKTOP_CHROME_MODE` requests the default. There is no OS, architecture or Electron-version allowlist. Mode is fixed for the window lifetime; changing configuration affects the next window. System decoration retains desktop identity and other legitimate bridge capabilities. Recovery does not switch decoration modes.

## Appearance and height (CHR-02)

The window creation policy accepts an optional `overlayHeight`. An omitted height uses Electron’s system default on all three platforms. The desktop composition root explicitly requests the demo product’s `PRODUCT_HEADER_HEIGHT` (48). macOS uses native traffic-light placement. Windows and Linux also accept runtime overrides. With system decoration the host omits all overlay options.

These alignment values assume default fonts and 100% page zoom. Electron API units must not be equated with zoomed CSS pixels. Do not rescale WCO/DOM coordinates using display scale or derive viewport coordinates by simply dividing screen DIP by page zoom.

Main derives the application color scheme from the in-memory visual mirror, loaded from `visual.json` before creating windows. Missing fields use the shared product defaults. Explicit light and dark select native colors. Auto follows the system. Mirror updates apply nativeTheme before per-window chrome, including while a disk write is pending. A fixed window retains its creation appearance. Generic preferences do not supply the theme. Dark color/symbolColor defaults are `#17191d`/`#f3f4f6`; light defaults are `#ffffff`/`#202124`. Desktop environment/session strings are diagnostic hints, not proof that Chromium uses Wayland. Native theme/button parity is not guaranteed across every Linux or macOS configuration.

## Runtime contract (CHR-03)

Shared contracts are browser-safe with no Node or Electron runtime dependency. Bootstrap version 1 contains desktop shell identity and resolved chrome mode. Only implemented native-overlay and system-decorated modes are accepted. Native fullscreen is distinct from the web Fullscreen API.

Window state contains monotonically increasing `revision`, `focused`, `maximized` and `fullscreen`. Overlay appearance contains optional `color`, `symbolColor` and `height`; results are applied with accepted appearance, unsupported with reason, or rejected with reason.

`useChromeSnapshot()` and the business `useAppEnvironment()` expose the same document snapshot, with effective shell at the top level. Its `chrome` field (also available from `useChromeState()`) contains the effective native fullscreen value, mode, enhancement status (`pending`, `available`, `unavailable`), the live `canSetOverlayAppearance` capability, optional window state, and bounded diagnostics (`invalid-bootstrap`, `host-mismatch`, `bridge-failed`). Missing window state means unknown, not an invented all-false state. Diagnostics reveal differing field names, not full payloads.

The runtime provides `getSnapshot()`, `getServerSnapshot()`, `subscribe(listener)`, `connect(bridge)` and `declareOverlayAppearance(owner, appearance)`. Subscriptions/connections return cleanup functions. Construction does not access the DOM or call the bridge. Snapshot references remain stable without state changes, supporting `useSyncExternalStore`.

Window revision is a host state sequence, not the whole runtime sequence. Old revisions, previous connection generations and late appearance results must not overwrite a new connection. A valid first connection retains the optional SSR fullscreen seed until native state arrives. Absence, failure, disconnect or replacement clears the effective value until the next native update. A StrictMode or Activity effect reconnect can therefore render an unknown fullscreen state.

## Bridge contract (CHR-04)

The chrome bridge exposes bootstrap, window state subscription and the window’s overlay declaration. It does not expose arbitrary IPC, Electron objects or minimize/maximize/close commands. Platform-specific preference methods are a host concern.

Bootstrap is synchronous immutable creation data, not a synchronous IPC request. The Electron host passes JSON through `--desktop-bootstrap=` in additional arguments. It contains no credentials, dynamic state or geometry. Version 1 limits the argument to 2048 characters, individual OS/session strings to 128, and platform to darwin/win32/linux. Fields are allowlisted; invalid input returns null. Hydration and bootstrap precedence follow the layout specification.

`subscribeWindowState` registers the event listener before requesting current state. It returns unsubscribe and never exposes raw IPC events. Tokens bind subscriptions to the current main document; navigation, renderer exit and window closure revoke old subscriptions. Duplicate callback registrations have independent lifetimes. Removing the final listener releases IPC listeners.

Appearance updates allow only color, symbolColor and height, with at least one valid value. Colors are `#RRGGBB` or `#RRGGBBAA`; height is an integer from 32 through 80. Preload and main both validate. Windows/Linux native-overlay uses `setTitleBarOverlay`; unchanged values do not cause another write. macOS and system-decorated return unsupported. Invalid values/senders or native failure return rejected without changing mode.

The host shares one system theme listener across open windows. Each window following the system applies the update with its own appearance overrides. Main issues a document token for overlay declarations from the current trusted document. Visual mirror pushes use the stamped record. A committed main-document navigation or renderer exit retires the token. Same-document navigation keeps it.

The theme layer owns window background and default overlay colors. Appearance writes only change the overlay layer and never change the background. Omitted colors inherit the current theme and an omitted height inherits the window policy height. System or explicit theme changes retain all declared overrides. `declareOverlayAppearance` accepts an owner token, increasing revision and a complete appearance snapshot or null release. Removed fields return to their current defaults; stale revisions and conflicting active owners are rejected. Main consumes the revision before applying the native update. Only a successful update commits the owner and override. An old owner release cannot clear another owner. A committed main-document navigation or renderer exit clears the window’s override; cancelled or failed navigation attempts retain the current document state. A layout can opt into a window-scoped declaration through `useOverlayAppearance()`; the stock App Shell uses it for its optional override. Components observe window state through `useAppEnvironment().chrome` or the adapter hooks. A document uses a stable bridge reference for declaration revisions across adapter remounts. Every IPC checks the registered window, current main frame and trusted app URL; lifecycle cleanup invalidates listeners, tokens and asynchronous results.

## Geometry and interaction (CHR-05)

The browser exposes WCO geometry independently of the preload and layout. The environment stylesheet provides `--app-window-area-{x,y,width,height}` and `--app-window-safe-{top,left,right}` in physical viewport CSS coordinates. A regular browser tab has zero insets. Any UI can read these values directly, including before hydration. The document’s optional fallback and the stock shell’s fusion policy are consumers described in LAY-04 and LAY-05 in [the layout specification](./layout.spec.md).

`getDragRegionProps()` adds `data-window-drag`; `getInteractiveProps()` adds `data-window-interactive`, preserving caller props. Drag regions are explicit. Buttons, inputs and portal surfaces require no-drag. A transparent full-window portal root must not erase every drag region. Native drag, double-click, system menu, resize and Snap behavior use the native path rather than JavaScript window-manager emulation.

The browser owns resize, container queries and zoom layout. The host subscribes only to required facts such as focus, maximize and native fullscreen. Correct CSS markers alone do not establish native interaction correctness.

## Recovery (CHR-06)

Both implemented decoration modes use the same bounded recovery coordinator. Main-document load failure or abnormal renderer exit permits at most one automatic reload per failure cycle, coordinated with utility readiness. Further failure offers native Reload/Close/Cancel. Escape keeps the windows open and dismisses the failure prompt. Unresponsive first offers Wait/Reload/Close without automatic reload. Windows affected by the same renderer failure share one native choice when they require a decision at the same time; the dialog names the scope and each window checks that its failure is still current. A recovered window immediately releases its pending choice. If it owned a shared sheet, surviving affected windows can present the choice again. Normal navigation cancellation, subframe failure and normal exit are not window failures. Route errors, 404 and bootstrap failure use page fallback rather than host reload.

The reload target must be a validated application document URL, updated by navigation. Before the first successful load use the original valid target, never a blank or external URL. A failure cycle ends after a successful main document remains stable for 30 seconds. Utility-triggered reload consumes the same single automatic allowance; manual retry does not reset it. Utility restart has its own budget.

Recovery waits for utility starting/ready/failed state and generation. Restart and window-error listeners must not reload concurrently. Wait preserves a pending load; retry stops it and invalidates its result before a new load. A utility generation change retires stale load retries. A hung renderer’s native choice remains valid across utility restarts until that renderer recovers, navigates, exits or closes. Native dialogs introduce no file/data error page, new trusted source or main-process static server. Recovery does not restore renderer memory or detect arbitrary CSS/React failures.
