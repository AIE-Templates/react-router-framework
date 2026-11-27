# SSR visual cookie

An SSR build uses the cookie named by `cookieName("visual")` to render the request's initial appearance. Its value is the URL-encoded, canonical JSON for the same stamped visual record held in local storage. The cookie is client-writable, scoped to `Path=/`, and uses `SameSite=Lax`, a one-year maximum age, and `Secure` on HTTPS.

The Fullstack root loader validates the request cookie with `readVisualRequestSeed(request)` and passes the record to `managersInitialState.visual`. A missing or invalid cookie yields the product defaults. The request seed is used only for SSR and React hydration.

At Web SSR startup, the prepaint script and the manager's first `connect()` each read the current `document.cookie`, then fall back to local storage if the cookie is missing, invalid or unavailable. The first valid source wins regardless of stamp. Prepaint only applies the selection. On first connection the manager re-reads the sources and copies the selected record with its original stamp to every available store whose value differs. If neither source is valid, the page uses defaults and writes nothing. If the page committed before its first connection, that connection uses runtime ordering. Runtime reconciliation, write verification, and retry behavior follow the [global visual state specification](visual.spec.md).

In a SPA build, the root loader runs at build time without a user cookie. The browser uses local storage for visual preferences and reports the cookie store as `absent`.

Caching of SSR responses follows the [Fullstack host specification](fullstack-host.spec.md).
