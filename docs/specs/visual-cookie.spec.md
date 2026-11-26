# SSR visual cookie

An SSR build uses the cookie named by `cookieName("visual")` to render the request's initial appearance. Its value is the URL-encoded, canonical JSON for the same stamped visual record held in local storage. The cookie is client-writable, scoped to `Path=/`, and uses `SameSite=Lax`, a one-year maximum age, and `Secure` on HTTPS.

The Fullstack root loader validates the request cookie with `readVisualRequestSeed(request)` and passes the record to `managersInitialState.visual`. A missing or invalid cookie yields the product defaults. React hydrates from that server snapshot. Before paint, the inline script reads the current cookie and local storage and applies the newest valid record. After mount, VisualManager reconciles those sources with its in-memory record and repairs older or missing copies. Defaults alone cause no writes. Record ordering, write verification, and retry behavior follow the [global visual state specification](visual.spec.md).

In a SPA build, the root loader runs at build time without a user cookie. The browser uses local storage for visual preferences and reports the cookie store as `absent`.

The Fullstack host sets `Cache-Control: private, no-store` on dynamic SSR HTML and Router `.data` responses, including requests without a visual cookie. The SPA shell and prerendered files keep their static cache headers. See the [Fullstack host specification](fullstack-host.spec.md).
