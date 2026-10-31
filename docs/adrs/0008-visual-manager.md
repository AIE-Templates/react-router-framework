# ADR 0008: Isolate visual preferences from UI and host adapters

Status: Accepted

A template must support identical visual preferences with or without a component library and in SSR
or static rendering. UI-library persistence and application state must not become competing writers.

Core therefore owns one VisualManager with validated, versioned preferences. Registries provide
stable composition boundaries; the domain provider owns instance lifecycle. A self-contained parser
is shared with the prepaint script so first paint does not wait for React. Separate server/client
snapshots preserve hydration structure while giving UI adapters the actual browser preference before
mount. Default system preferences can fall back to CSS when scripts cannot run.

UI and platform integrations consume the manager and report their own synchronization results.
They do not change preference authority. Persisted future versions are protected; concurrent tabs
use last-write semantics rather than an unimplemented transaction guarantee.
