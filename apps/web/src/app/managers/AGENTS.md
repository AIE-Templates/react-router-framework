# Domain managers

Keep state, commands, subscriptions, lifecycle, persistence, context and hooks together by domain. UI-library adapters belong in a domain's adapter subdirectory; user-facing UI belongs in components/ or its feature. Environment runtime/context/hooks/dom-props live in environment/. AppRoot creates that runtime directly; do not register it with ManagersRegistry. Core environment code contains no host protocol implementation. VisualManager remains the single authority for appearance; adapters consume it rather than creating another preference store.

VisualManager reconciles the maximum observed record across memory, local storage, the SSR cookie and an optional native replica. Keep request seeds in the server snapshot and adopt the read-only prepaint handoff during render. Re-read Web targets before repair. Actions, including single-field and whole resets, commit sparse records. Report failures per store and guard native push completions by their owning operation.
