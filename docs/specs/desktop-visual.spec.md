# Desktop visual synchronization

## Application color scheme

Electron main owns the application-wide color scheme. It loads `visual-theme.json` from the application's user data directory before creating the first window. The version 1 record contains `colorScheme: auto | light | dark`. Missing, corrupt or unknown-version records use `auto`. Direction and reduced motion remain preferences of the renderer's same-origin visual store. Generic `prefs.json` and preference cookies keep their own storage and APIs.

A color scheme command uses `syncVisualTheme`. Main validates the current trusted main frame, its document token, the preference and its request revision. It durably writes the versioned preference via temporary file and rename before publishing a changed snapshot to windows. Snapshots carry the preference and a host revision scoped to the running process. A persistence failure leaves the previous committed snapshot and window appearance in effect. The user can retry the failed command. The command result reports the native background and overlay outcomes for the requesting window independently of persistence.

## Window creation and document lifecycle

Windows inherit the committed theme unless their creation policy specifies a fixed appearance. SSR uses trusted desktop request context for the HTML seed. Preload exposes a synchronous `visualTheme` snapshot for the document's prepaint script, including in a static SPA. It takes precedence over a stale color scheme in renderer storage. The renderer still reads direction and reduced motion from its own preferences.

The renderer subscribes through `subscribeVisualTheme`. Preload attaches the change listener before requesting the latest snapshot and delivers only newer revisions. New windows, document reloads and effect reconnections adopt the current snapshot. Mounting, receiving an update and observing another window's storage changes do not issue a color scheme command. Retiring a document or connection invalidates its pending work. A fresh process restores the saved preference with a new revision sequence.

## Native defaults and window overrides

The effective window theme supplies the background on every platform and the default title-bar overlay colors on Windows and Linux in native-overlay mode. Before creating the first window and after each committed preference change, main sets `nativeTheme.themeSource` to `light`, `dark`, or `system` for `auto`. This supplies the inherited native appearance and the renderer’s preferred-color-scheme media value. Window overlay declarations only customize the overlay.

Each window's App Shell can declare its own `overlayAppearance`. Omitted colors follow the current theme, and an omitted height uses the window policy height. Main recomputes the effective overlay after each declaration or theme change. Releasing the declaration restores the latest defaults. An override affects only that window's title-bar overlay. Other windows keep their own declarations, navigation, panel state and drafts. See the [window chrome specification](window-chrome.spec.md) for ownership and cleanup.

A child window can select a fixed `light` or `dark` appearance at creation. Main supplies the initial background and overlay defaults and includes the selection in the window’s immutable preload bootstrap. The prepaint script and VisualManager use it for the resolved color scheme on every document in that window. The stored application preference still synchronizes across windows.

On macOS the host pins the hidden child’s `NSWindow.appearance` before showing it. The native adapter preserves that value when Electron reapplies the application theme. Editable text and selections open the native context menu at the event coordinates in the originating window and frame.
