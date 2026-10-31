# Optional visual cookie mirror

Set VITE_VISUAL_COOKIE=true at build time to enable the Web SSR preference mirror. It is disabled
by default. Rebuild both server and client together when changing this flag. Electron documents
never activate the Web cookie writer.

The application-prefixed cookie contains only the versioned VisualPreferences record. It is
client-writable, Path=/, SameSite=Lax, valid for one year and Secure on HTTPS. It contains no identity
or authorization data. The per-request server reader validates it and returns only the visual seed.
Registries distribute that seed to the provider; revalidation does not recreate the manager.

Local storage wins at client bootstrap; a valid cookie seed fills missing browser preferences.
Initialization attempts to save the adopted seed once when local storage is missing or malformed;
future-version records are preserved. Later storage events never trigger initialization writes.
External deletion or clear restores defaults and updates the cookie without recreating a local record.
The cookie is an adapter mirror, never a second application command API. Writes are verified and
reported through useVisualCookieStatus, independently of localStorage persistence. A retry is
available. Whole reset can replace a future-version cookie; ordinary writes cannot downgrade it.

With the adapter enabled, host responses containing HTML and Router .data responses use
Cache-Control: private, no-store. Static assets retain their existing cache policy. With SSR=false,
the root loader only runs at build time without a user cookie; the prepaint script/localStorage
provide the complete experience and the client can still update its mirror. No route headers
export or server-only module is imported into the client graph.
