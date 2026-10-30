# Restore container scroll by history entry and make main landmarks explicit

Status: Accepted

## Context

The application scrolls in root/module containers, while Router ScrollRestoration restores the window. Nested modules must not each create a main landmark.

## Decision

Track container positions per history key, reset new navigation, restore POP and resolve fragments. Keep at most 100 entries in the current document. Module content defaults to div; a page opts one top-level region into main.

## Consequences

Back/forward restores container positions without promising reload/restart persistence. Module IDs must be unique within a page. Router continues to own window scrolling; nested/parallel modules keep default div containers.
