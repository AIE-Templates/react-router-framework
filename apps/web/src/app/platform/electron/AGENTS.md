# Electron web adapters

Keep Electron host integration here: shell contexts, preference helpers and visual-state synchronization. These adapters may consume Core managers and shared browser-safe contracts; Core must not import host protocol implementations. Root, host code and route modules may compose adapters, and features may call the exported preference API without branching on shell identity.

Use ~/platform/electron for application-root imports and ./ for colocated modules. Do not import src/host from application code. Keep true host-dependent tests under src/host with an explicit Node or jsdom environment; retain pure module/component tests beside their sources. Mock paths follow the same alias rules.

Preference cookies use PREFERENCE_COOKIE_PREFIX from @repo/shared, derived with cookieName("pref_"). Use the constant for names and byte-limit calculations, never a second literal prefix. Old pref-* cookies are intentionally ignored. Preferences are display state and never authorization or credentials. VisualManager remains the appearance authority; the Electron mirror does not create another preference store.
