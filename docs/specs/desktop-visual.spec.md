# Desktop visual mirror

## Ownership and wire format

Each renderer uses VisualManager and the shared record codec. It reconciles the greatest observable whole record across memory, localStorage, the visual cookie in SSR builds, and the application mirror. The SSR document and Router data read the request cookie. Shared localStorage events wake other windows. With localStorage unavailable, another window catches up on its next command, restoration or reload.

Main loads `visual.json` from the selected userData directory before creating the first window. Missing or invalid data leaves the mirror empty. An I/O error other than `ENOENT` leaves it unread. Reads, pushes, window creation and quit retry the disk read while unread. Main adopts the recovered record before comparing a push and returns `failed` for pushes while the file remains unreadable. Initial defaults require no write. The file and bridge carry the canonical JSON defined in the [visual specification](visual.spec.md). Product defaults resolve sparse fields. Renderer writes own cookie synchronization. Generic preferences use their separate store.

## Bridge and durability

Preload caches one synchronous `desktop:visual:read` as `visualSeed` per document. Main includes the optional fixed appearance of the registered sender window in this sample. The prepaint reader uses both fields. On connection, `readVisual()` reads the current mirror. An empty mirror reports `{ record: null, pending: false }`. An unread mirror reports `{ record: null, pending: true }`, so start skips its record and the renderer can report the storage failure. A trusted main frame can invoke `pushVisual(raw)` over `desktop:visual:push`. Both handlers validate the registered sender. Ordering comes from the record stamp and canonical tie-breaker. Overlay declarations retain their document token and revision.

Main decodes each push. A newer record is written synchronously using a temporary file, fsync and rename, then applied in memory. A failed write still updates memory and native appearance with the new record and marks it pending. Every push retries pending data, and a newer push can replace it with the new maximum. An older valid record receives `ok` even if the newer one remains pending. Equal records confirm durability. Invalid records and denied pushes receive `failed`; IPC exceptions yield `unavailable`. Reads never trigger a write.

Host-created windows, allowed renderer-opened children and `before-quit` retry pending writes. A refreshed renderer sees pending as a failed native store. Automatic repair pushes only a missing or older mirror. Explicit retry can confirm an equal pending record. Confirmation of the current record establishes the durability boundary for a cold restart. An ignored older push only confirms that main already holds a newer record. If the process exits before the push arrives, the next renderer repairs the mirror from any surviving newer Web record. If Chromium loses its newest copies, a surviving mirror repairs Web storage after prepaint.

## Native defaults and window overrides

The effective window theme supplies the background on every platform and the default title-bar overlay colors on Windows and Linux in native-overlay mode. Before creating the first window and after each effective mirror color change, main sets `nativeTheme.themeSource` to `light`, `dark`, or `system` for `auto`. This supplies the inherited native appearance and the renderer’s preferred-color-scheme media value. Window overlay declarations only customize the overlay.

Each window's App Shell can declare its own `overlayAppearance`. Omitted colors follow the current theme, and an omitted height uses the window policy height. Main recomputes the effective overlay after each declaration or theme change. Releasing the declaration restores the latest defaults. An override affects only that window's title-bar overlay. Other windows keep their own declarations, navigation, panel state and drafts. See the [window chrome specification](window-chrome.spec.md) for ownership and cleanup.

A child window can select a fixed `light` or `dark` appearance at creation. Main supplies the initial background and overlay defaults and returns the selection in each document’s synchronous visual sample, keyed by its webContents even when the window shares its opener’s renderer. The prepaint script and VisualManager use it for the resolved color scheme on every document in that window. The stored application preference still synchronizes across windows.

On macOS the host pins the hidden child’s `NSWindow.appearance` before showing it. The native adapter preserves that value when Electron reapplies the application theme. Editable text and selections open the native context menu at the event coordinates in the originating window and frame.
