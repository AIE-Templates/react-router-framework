# Domain managers

Keep state, commands, subscriptions, lifecycle, persistence, context and hooks together by domain. UI-library adapters belong in a domain's adapter subdirectory; user-facing UI belongs in components/ or its feature. Environment runtime/context/hooks/dom-props live in environment/. AppRoot creates that runtime directly; do not register it with ManagersRegistry. Core environment code contains no host protocol implementation. VisualManager remains the single authority for appearance; adapters consume it rather than creating another preference store.
