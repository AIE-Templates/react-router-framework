# Use native overlay controls with a persistent CSS safety boundary

Status: Accepted

## Context

Custom-drawn controls increase platform responsibilities, while hydration/errors can temporarily remove application headers.

## Decision

Use native-overlay by default on supported desktop platforms, explicit system decoration as an alternative, and a root WCO-based fallback independent of identity/provider readiness. Only complete direct shell/header compositions hand off the fallback.

## Consequences

Native interaction stays native. Geometry responds through CSS, with one shell appearance owner. Recovery remains a separate bounded native-dialog flow and does not change decoration mode or restore renderer memory.
