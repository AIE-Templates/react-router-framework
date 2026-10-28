# Separate application root, shell and module layout

Status: Accepted

## Context

The same application must work across web/desktop, SSR/SPA and narrow/wide containers without business modules owning platform policy.

## Decision

AppRoot owns effective environment and providers; AppShell owns navigation and window composition; ModuleLayout owns module panels and workspace state. Trusted preload bootstrap follows matching initial hydration and supersedes the initial seed.

## Consequences

Business modules remain platform-independent. Root safety CSS and fallback persist outside route children and do not depend on enhancement readiness. Responsive changes preserve business state.
