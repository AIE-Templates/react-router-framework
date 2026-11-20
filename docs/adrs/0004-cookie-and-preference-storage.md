# Separate server cookies from client display preferences

Status: Accepted

## Context

Chromium does not expose document.cookie for app:// and protocol responses do not perform normal network cookie processing. SSR still needs standard server cookies and client-selected display preferences.

## Decision

Main manages server cookies in a dedicated session using an internal HTTPS storage key and flushes mutations before returning responses. Small display preferences use one helper: web cookies named with `PREFERENCE_COOKIE_PREFIX = cookieName("pref_")` from `@repo/shared` (default `framework-app_pref_`) or desktop atomically persisted prefs.json injected into trusted requests.

## Consequences

Server code keeps ordinary cookie behavior; page scripts use loader data/localStorage for readable state. Shared limits keep preference values portable. Preferences never authorize access.

Both packages encrypt cookies (fuse), so a packaged launch can reach the macOS keychain or a Linux keyring. Test launches and the `verify:release` startup check pass `--use-mock-keychain` (macOS; measured to keep the release package off the login keychain) or `--password-store=basic` (Linux) so they never prompt or hang; consequently no automated check exercises the real credential store, and Windows uses per-user DPAPI without a switch. Application cookie behavior is verified on the test profile; release is verified from outside ([ADR 0011](0011-build-profiles.md)).

On Windows, Chromium writes a new profile's cookie key to Local State only about 10 s after startup or at a clean quit (measured on Windows 11 arm64; electron/electron#55978, open), so a packaged app that crashes before then loses flushed persistent cookies. A test or release launch whose Local State has no key first runs a short-lived copy of the app that lets Chromium create and persist the key, waiting at most 5 s, at the cost of one extra start and quit on a profile's first launch (measured 100–300 ms on Windows 11 arm64, recorded as `cookie-key-writer-ms`; Windows x64 untested) and a file read on later ones. A probe encrypted by the copy with safeStorage's synchronous API, which Electron 45 deprecates but which was measured to share the cookie key, confirms the launch uses that key. A run that leaves no key is recorded in userData with the application version; that version skips the writer for a day, and the record is deleted once a key is found. An unreadable Local State records nothing. Dev builds are excluded and unpackaged launches lose nothing: unfused Electron stores cookies unencrypted. The hardened failure paths have unit tests only. The writer is removed once Electron persists the key when it creates it.

The preference cookie prefix is derived from the same `APP_ID` as other persisted application identifiers; serializers, parsers and capacity checks use the shared constant. Old `pref-*` cookies are intentionally not migrated in this unshipped template and may reset to defaults. Existing visual localStorage and visual cookie names are unchanged. The web preference adapter lives in `platform/electron/preferences.ts`; this relocation does not change its host-specific storage contract.
