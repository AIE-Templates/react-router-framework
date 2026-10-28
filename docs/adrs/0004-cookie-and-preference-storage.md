# Separate server cookies from client display preferences

Status: Accepted

## Context

Chromium does not expose document.cookie for app:// and protocol responses do not perform normal network cookie processing. SSR still needs standard server cookies and client-selected display preferences.

## Decision

Main manages server cookies in a dedicated session using an internal HTTPS storage key and flushes mutations before returning responses. Small display preferences use one helper: web pref-* cookies or desktop atomically persisted prefs.json injected into trusted requests.

## Consequences

Server code keeps ordinary cookie behavior; page scripts use loader data/localStorage for readable state. Shared limits keep preference values portable. Preferences never authorize access. Release cookie encryption can require OS keychain access; test-profile and release-profile have distinct validation paths.
