# Host the web application in an Electron utility process

Status: Accepted

## Context

Desktop must reuse Hono and Router without a production TCP listener. Native app-scheme URLs need HTTP same-origin semantics for Router, typed clients and CSRF.

## Decision

Main maps app://app to an internal HTTP origin and sends Request/Response streams to utility over port-fetch. Utility owns the entire web host and static resources. Main/preload use CommonJS and utility uses ESM.

## Consequences

The renderer shares the web build and has no Node API. Main avoids server top-level-await dependencies. Host lifecycle, cancellation and mapping are explicit; internal URLs must not become public links.
