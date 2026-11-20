# Separate server cookies from client display preferences

Status: Accepted

## Context

Chromium does not expose document.cookie for app:// and protocol responses do not perform normal network cookie processing. SSR still needs standard server cookies and client-selected display preferences.

## Decision

Main manages server cookies in a dedicated session using an internal HTTPS storage key and flushes mutations before returning responses. Small display preferences use one helper: web cookies named with `PREFERENCE_COOKIE_PREFIX = cookieName("pref_")` from `@repo/shared` (default `framework-app_pref_`) or desktop atomically persisted prefs.json injected into trusted requests.

## Consequences

Server code keeps ordinary cookie behavior; page scripts use loader data/localStorage for readable state. Shared limits keep preference values portable. Preferences never authorize access.

Both packages encrypt cookies (fuse), so a packaged launch can reach the macOS keychain or a Linux keyring. Test launches and the `verify:release` startup check pass `--use-mock-keychain` (macOS) or `--password-store=basic` (Linux) so they never prompt or hang; consequently no automated check exercises the real credential store, and Windows uses per-user DPAPI without a switch. Application cookie behavior is verified on the test profile; release is verified from outside ([ADR 0011](0011-build-profiles.md)).

On Windows, Chromium writes a new profile's cookie key to Local State only about 10 s after startup or at a clean quit (electron/electron#55978, open), so a crash before then loses flushed persistent cookies. A test or release launch whose Local State has no key first runs a short-lived copy of the app that only lets Chromium create and persist the key, at the cost of one extra start and quit (measured 100–130 ms on Windows 11 arm64; Windows x64 untested) on a profile's first launch and a file read on later ones. A probe encrypted by the copy confirms the launch uses that key; a failed writer run is recorded in userData and not retried. Dev builds are excluded: their unfused Electron stores cookies unencrypted. The writer is removed once Electron persists the key when it creates it.

The preference cookie prefix is derived from the same `APP_ID` as other persisted application identifiers; serializers, parsers and capacity checks use the shared constant. Old `pref-*` cookies are intentionally not migrated in this unshipped template and may reset to defaults. Existing visual localStorage and visual cookie names are unchanged. The web preference adapter lives in `platform/electron/preferences.ts`; this relocation does not change its host-specific storage contract.
