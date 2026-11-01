# Separate server cookies from client display preferences

Status: Accepted

## Context

Chromium does not expose document.cookie for app:// and protocol responses do not perform normal network cookie processing. SSR still needs standard server cookies and client-selected display preferences.

## Decision

Main manages server cookies in a dedicated session using an internal HTTPS storage key and flushes mutations before returning responses. Small display preferences use one helper: web cookies named with `PREFERENCE_COOKIE_PREFIX = cookieName("pref_")` from `@repo/shared` (default `framework-app_pref_`) or desktop atomically persisted prefs.json injected into trusted requests.

## Consequences

Server code keeps ordinary cookie behavior; page scripts use loader data/localStorage for readable state. Shared limits keep preference values portable. Preferences never authorize access. Release cookie encryption can require OS keychain access; test-profile and release-profile have distinct validation paths.

The preference cookie prefix is derived from the same `APP_ID` as other persisted application identifiers; serializers, parsers and capacity checks use the shared constant. Old `pref-*` cookies are intentionally not migrated in this unshipped template and may reset to defaults. Existing visual localStorage and visual cookie names are unchanged. The web preference adapter lives in `platform/electron/preferences.ts`; this relocation does not change its host-specific storage contract.
