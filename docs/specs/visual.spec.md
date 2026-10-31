# Global visual state

Core provides `ManagersRegistry` → `VisualManagerRegistry` → `VisualManagerProvider`.
Registries are stateless composition boundaries. The provider creates one stable, document-scoped
VisualManager and owns connection cleanup. Context carries the instance; hooks subscribe to immutable
state/status snapshots and expose stable actions. Server requests never share a mutable instance.

## Preferences and persistence

`VisualPreferences` contains `colorScheme: auto | light | dark`, `direction: ltr | rtl`, and
`reducedMotion: auto | reduce | full`. Defaults and whole resets are auto/ltr/auto. Resolved state is
light/dark, ltr/rtl and a motion boolean; it is never persisted. Explicit modes override media queries.

`config/storage.ts` defines a stable application ID, prefix and key. Change the ID when making a new
application. The value is `{ version: 1, preferences }`. Known records are validated per field;
unknown versions are preserved until an explicit whole reset. Single-field resets preserve other
preferences. Never clear unrelated storage. Storage failures retain the current session state and
are reported separately; repeated commands retry persistence. External storage changes reconcile
without write echoes. Concurrent documents use last successful whole-record write semantics.
Reconnects reread storage without writing. Once a stored record has been observed, its removal
restores defaults instead of replaying a request seed. A never-persisted seed and unsaved session
commands survive effect replay; unavailable storage does not erase the current session. Every
connection re-resolves system appearance and motion, including after failed or unavailable storage,
without retrying an unsaved write.

## First paint and hydration

A single `VisualInitScript` in head uses the same self-contained parser as the runtime. It reads local
storage, resolves system preferences, applies attributes and hands off a document-local bootstrap
record. Fresh accessible storage takes precedence when a manager is recreated; the bootstrap is only a fallback if storage access fails. It accepts a CSP nonce; its bytes are deterministic for static rendering. UI integrations can
supply extra color attributes through data-only `config/visual-integration.ts`.

Core uses `data-color-scheme`, standard `dir`, and `data-reduced-motion`. Server-unknown auto attributes
are omitted, allowing media-query CSS fallback. CSS `color-scheme` tracks the resolved appearance.
The prepaint bootstrap retains both preference and resolution: a dark DOM cannot distinguish auto
from explicit dark.

The manager's server snapshot remains the SSR seed. Its client snapshot is prepared synchronously,
without effects, before child UI providers mount. React's external-store hydration path uses the
server snapshot; adapters read the client snapshot. HTML hydration suppression is element-wide:
nonvisual host attributes must still be tested independently. Content structure must remain stable.
The document's visual attribute props retain the initial seed, while the manager owns subsequent
attribute updates. Route revalidation must not recreate the manager.

## Composition and scope

AppRoot owns state providers outside Document; AppUiProvider is a transparent body slot for optional
UI libraries. The inline window safety fallback remains outside route content. Layout geometry,
platform identification and window bridges keep their existing owners. Core contains no UI-library
or Electron persistence protocol. Reduced motion affects the sample's transitions; explicit full
permits them even when the OS requests reduced motion. Direction changes layout through logical CSS,
without reversing the native window's physical reserved geometry.
