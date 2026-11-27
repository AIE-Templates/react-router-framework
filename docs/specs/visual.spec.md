# Global visual state

Core provides `ManagersRegistry` → `VisualManagerRegistry` → `VisualManagerProvider`. Each document has one manager. Its provider owns the connection and cleanup. React hooks subscribe to immutable state and status snapshots. Requests have separate server snapshots.

## Records and defaults

`@repo/shared` owns `VisualPreferences`, the build-time `VISUAL_DEFAULTS` and `visualRecordKernel`. The template defaults are `colorScheme: "auto"`, `direction: "ltr"` and `reducedMotion: "auto"`. Products can change their defaults. A missing field adopts the new default on upgrade. Explicit selections survive, including a selection equal to a previous default.

Every store carries the same canonical JSON payload. For example, choosing only RTL writes a record of this shape:

```json
{ "version": 1, "stamp": { "t": 123, "id": "abc" }, "preferences": { "direction": "rtl" } }
```

The codec distinguishes missing, invalid and valid input. Unknown keys, an incompatible version, an invalid stamp or any invalid preference invalidate the whole record. Stamp time is a nonnegative integer up to the JavaScript Date limit (8.64e15), and the ID is 1–64 UTF-16 code units. Direction accepts `ltr | rtl`, color scheme accepts `auto | light | dark` and motion accepts `auto | reduce | full`. The wire encoder emits compact JSON in a fixed field order. Readers compare complete records by time, then ID, then canonical preference JSON using UTF-16 code units. A commit advances time to the greater of the current clock and the highest observed time (including valid records discarded at start) plus one, with a random ID from Web Crypto. At the exact Date limit, advancing by one produces a stamp outside the decodable range.

The record shape is frozen. Adding a field or an allowed value, or changing `version`, requires a new storage key and cookie name. Builds repair undecodable replicas from memory and would otherwise overwrite each other.

## Storage and convergence

The replicas, in upstream order, are the optional Electron main mirror (N), the SSR visual cookie (C) and local storage (L). Local storage uses `storageKey("visual-preferences")`. Page and host share `serializeVisualCookie(raw, secure)` from `@repo/shared`. It encodes the wire record under `cookieName("visual")` with a one-year lifetime, path `/`, `SameSite=Lax` and `Secure` on HTTPS.

| Mode         | Start priority and commit write order |
| ------------ | ------------------------------------- |
| Web SPA      | L                                     |
| Web SSR      | C → L                                 |
| Electron SPA | N → L                                 |
| Electron SSR | N → C → L                             |

**Start.** Prepaint and the manager's first `connect()` each read the current replicas in priority order. The first available, valid record wins regardless of stamp. Prepaint only paints. Connection adopts the selected record and copies it, with its original stamp, to every available replica with a different, invalid or missing record. When all replicas are missing, invalid or unavailable, the page uses defaults and writes nothing. If a child already committed before the first connection, that connection uses runtime reconciliation to preserve the edit.

**Runtime.** A relevant storage event, a bfcache restore (`pageshow` with `persisted === true`), becoming visible, retry and reconnection select the maximum whole record across the page's memory and observable replicas. A storage event for the visual key also contributes its `newValue` when it decodes to a valid record. The manager repairs lagging replicas with that stamp and re-reads Web targets immediately before repair. Deleting storage while a page holds a record allows it to restore the record. Use `resetVisualPreferences()` to propagate a reset.

A commit reads the same runtime maximum, edits its sparse preferences and stamps the result. It starts the asynchronous native push, writes and verifies the cookie, then writes local storage, skipping unavailable stores. If cookie verification finds a newer concurrent edit, that record also goes to native and local storage. Each setter records an explicit choice. Single-field reset deletes one field. Whole reset writes empty preferences with a new stamp. Sequential edits retain observable earlier fields. Concurrent edits can lose a field because the total order selects a whole record. If a runtime repair overwrites the last replica of a concurrent edit, an open tab recovers the edit from the storage event carrying it. The edit is lost only if its writer and the repairing tab both close before that event is handled. Independent SPA tabs with only memory cannot synchronize.

| Situation                                                                          | Expected outcome                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native push lost on termination, or disk write and all retries failed before quit  | Cold start paints the older native record and rolls Web storage back to it. The first frame matches the native window.                                                                                                           |
| Disk write pending while main is running                                           | New windows use main's current in-memory record. The panel reports the pending write.                                                                                                                                            |
| Web SSR cookie write failed and the older cookie survived                          | SSR and first paint agree on the older cookie. Connection restores it to local storage. An open tab holding the edit can repair both replicas on a storage event, so the new tab briefly shows the old value and then converges. |
| Flush lost a replica, Web storage was cleared, or a downstream record was modified | The first valid upstream refills missing or different replicas. An invalid upstream is repaired from the next valid source. Cleared Web storage with no native record gives defaults and zero writes.                            |
| An SSR request is in flight during another tab's commit                            | The request seed supplies hydration. Both start reads use the current document cookie, so the stale seed cannot overwrite it.                                                                                                    |

## Status and retry

`getStatus()` and `getServerStatus()` expose `initialized` and `storage: { local, cookie, native }`. Each store reports `ok`, `failed`, `unavailable` or `absent`. Only a mode without that store uses `absent`. A local access/read exception means unavailable. A local write exception means failed. Cookie read-back confirms an exact repair at start. At runtime it confirms the target or advances to a newer record. A missing cookie means unavailable. An invalid or older cookie means failed. Before its first write, a readable SSR cookie store counts as available.

A failed write leaves the new record usable in memory. Before the first connection, `retry()` does nothing. After initialization it re-reads current sources, repairs each different or missing replica and re-probes unavailable stores without advancing the clock. Page restoration also re-probes. The settings panel waits for initialization and offers retry when a store failed or all persistent stores are unavailable.

## First paint and hydration

The root loader reads a valid request cookie for SSR and hydration. The document renders effective server values, omitting automatic color and motion attributes for the CSS media-query fallback. `lang` remains an application concern. The deterministic inline script selects the start record, resolves media queries, applies document attributes and leaves its state on the window. It performs no writes to storage and carries no request seed. The shared record factory, DOM kernel, cookie reader and optional platform reader must remain serializable without module-scope dependencies.

The constructor adopts that handoff without touching storage or the bridge. React hydrates from the separate server snapshot. The manager connects after render and owns subsequent document updates, including media changes. Route revalidation preserves the document-scoped manager. `preferences` stays sparse. Use `visualRecordKernel.effective(snapshot)` for selected values and `snapshot.resolved` for the actual color scheme, direction and reduced-motion boolean.

## Platform and UI integration

`VisualManagerProvider` accepts an optional `nativeSource`. Supply a standalone, self-contained `prepaint` function returning the cached wire record and optional fixed window appearance. Its `connect(window)` function discovers the live bridge, whose synchronous `read()` returns `{ record, pending, fixedAppearance? }` and whose asynchronous `push(raw)` returns `ok | failed | unavailable`. An absent bridge is unavailable when the initial shell is desktop or a desktop bridge object exists. Ordinary Web reports absent. A pending mirror reports failed. Automatic repair pushes only a missing or older mirror. Explicit retry can confirm a pending equal record. An equal pending read keeps the outstanding push live. A durable equal record, a newer record, a read failure or bridge rediscovery invalidates its completion. An owned `ok` or `failed` push completion re-reads the mirror once under the runtime rule, so a newer record propagates to the page and Web replicas. The completion never resends the same record.

Each successful live read refreshes the optional fixed window appearance, including when prepaint missed it. A change notifies state subscribers and affects only the resolved color scheme. Direction and motion still inherit. Web components can style local regions independently. AppRoot owns providers outside the document. AppUiProvider is the body integration slot. Adapters consume the manager and can register extra document color attributes in `config/visual-integration.ts`.

## Semantic styles

Core applies `data-color-scheme`, `dir` and `data-reduced-motion` through a single DOM writer. CSS `color-scheme` tracks appearance. `styles/tokens.css` owns `--app-color-*`, `--app-font-sans`, `--app-radius` and `--app-shadow-surface`. Tailwind aliases use those tokens. Explicit motion and color override system preferences. Logical CSS changes layout direction while preserving physical native control geometry.
