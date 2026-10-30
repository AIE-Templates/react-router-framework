# Keep host protocols outside generic Core contracts

Status: Accepted

## Context

Core window layout needs environment and chrome capabilities, but request headers, IPC names, startup argument formats and storage belong to a concrete host.

## Decision

Core exports generic Shell and WindowChromeBridge contracts with shell/mode/fullscreen seeds. Electron owns desktop request/bootstrap parsing, IPC, preferences and its extended DesktopBridge.

## Consequences

Core can be inherited by web/static/fullstack applications without host protocols. Electron adapts its request context to the generic seeds rather than importing transport details into Core.
