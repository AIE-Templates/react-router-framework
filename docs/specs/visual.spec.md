# Global visual state

Core provides `ManagersRegistry` → `VisualManagerRegistry` → `VisualManagerProvider`. Each document has one manager. Its provider owns the connection and cleanup. React hooks subscribe to immutable state and status snapshots. Requests have separate server snapshots.

## Records and defaults

`@repo/shared` owns `VisualPreferences`, the build-time `VISUAL_DEFAULTS` and `visualRecordKernel`. The template defaults are `colorScheme: "auto"`, `direction: "ltr"` and `reducedMotion: "auto"`. Products can change their defaults. A missing field adopts the new default on upgrade. Explicit selections survive, including a selection equal to a previous default.

Every store carries the same canonical JSON payload. For example, choosing only RTL writes a record of this shape:

```json
{ "version": 1, "stamp": { "t": 123, "id": "abc" }, "preferences": { "direction": "rtl" } }
```

The codec distinguishes missing, invalid and valid input. Unknown keys, an incompatible version, an invalid stamp or any invalid preference invalidate the whole record. Direction accepts `ltr | rtl`, color scheme accepts `auto | light | dark` and motion accepts `auto | reduce | full`. The wire encoder emits compact JSON in a fixed field order. Readers compare complete records by time, then ID, then canonical preference JSON using UTF-16 code units. A commit advances time to the greater of the current clock and the highest observed time plus one, with a random ID from Web Crypto.

## Storage and convergence

Local storage uses `storageKey("visual-preferences")`. SSR builds also maintain `cookieName("visual")` with a one-year lifetime, path `/`, `SameSite=Lax` and `Secure` on HTTPS. SPA builds omit the cookie. An optional platform source provides a native replica.

- A commit first reads all available replicas and the current in-memory record, then edits the maximum and writes the new record to available stores. Each setter records an explicit choice. A single-field reset deletes that field. A whole reset writes an empty preferences object with a new stamp.
- On connection, a relevant storage event, `pageshow`, or a transition to visible, the manager reads the replicas again and repairs missing or older records. Web repairs re-read the target immediately before writing. Events convey invalidation, so their payloads cannot overwrite a newer record. Repair preserves the original stamp. Defaults alone cause zero writes.
- **Intentional behavior change:** manually deleting local storage while a page holds a record lets that page restore the deleted record on reconciliation. Use `resetVisualPreferences()` to propagate a reset.
- Sequential edits retain earlier fields whenever the next writer can observe the earlier record. Concurrent edits can lose a field because comparison selects one whole record. If the winning record loses its last copy before another page sees it, the remaining record survives. Without local storage, other tabs can observe changes through another shared replica on restore or commit. Independent SPA tabs with only memory cannot synchronize.

## Status and retry

`getStatus()` and `getServerStatus()` expose `initialized` and `storage: { local, cookie, native }`. Each store reports `ok`, `failed`, `unavailable` or `absent`. Only a mode without that store uses `absent`. A local access/read exception means unavailable. A local write exception means failed. Reading the visual cookie back after a write confirms success for the target or a newer record. A missing cookie means unavailable. An invalid or older cookie means failed. Before its first write, a readable SSR cookie store counts as available.

A failed write leaves the new record usable in memory. `retry()` re-reads current sources, repairs failed stores and re-probes unavailable stores without advancing the clock. Page restoration also re-probes. The settings panel waits for initialization and offers retry when a store failed or all persistent stores are unavailable.

## First paint and hydration

The root loader reads a valid request cookie for SSR and hydration. The document renders effective server values, omitting automatic color and motion attributes for the CSS media-query fallback. `lang` remains an application concern. The deterministic inline script reads current local storage, the current SSR-mode document cookie and the optional platform bootstrap. It selects once, resolves media queries, applies document attributes and leaves its state on the window. It performs no writes to storage and carries no request seed. The shared record factory, DOM kernel, cookie reader and optional platform reader must remain serializable without module-scope dependencies.

The constructor adopts that handoff without touching storage or the bridge. React hydrates from the separate server snapshot. The manager connects after render and owns subsequent document updates, including media changes. Route revalidation preserves the document-scoped manager. `preferences` stays sparse. Use `visualRecordKernel.effective(snapshot)` for selected values and `snapshot.resolved` for the actual color scheme, direction and reduced-motion boolean.

## Platform and UI integration

`VisualManagerProvider` accepts an optional `nativeSource`. Supply a standalone, self-contained `prepaint` function returning the cached wire record and optional fixed window appearance. Its `connect(window)` function discovers the live bridge, whose synchronous `read()` returns `{ record, pending }` and whose asynchronous `push(raw)` returns `ok | failed | unavailable`. An absent bridge is unavailable when the initial shell is desktop or a desktop bridge object exists. Ordinary Web reports absent. A pending mirror reports failed. Automatic repair pushes only a missing or older mirror. Explicit retry can confirm a pending equal record. Superseded push completions cannot change current status.

A platform-fixed window color scheme affects only resolution. Direction and motion still inherit. Web components can style local regions independently. AppRoot owns providers outside the document. AppUiProvider is the body integration slot. Adapters consume the manager and can register extra document color attributes in `config/visual-integration.ts`.

## Semantic styles

Core applies `data-color-scheme`, `dir` and `data-reduced-motion` through a single DOM writer. CSS `color-scheme` tracks appearance. `styles/tokens.css` owns `--app-color-*`, `--app-font-sans`, `--app-radius` and `--app-shadow-surface`. Tailwind aliases use those tokens. Explicit motion and color override system preferences. Logical CSS changes layout direction while preserving physical native control geometry.
