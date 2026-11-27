# @repo/shared

Browser-safe shared types, constants and validation. No Node imports or runtime dependencies. Workspace consumers use the @repo/source export condition configured in Vite, Vitest and TypeScript.

Shell describes host facts. Window chrome contracts describe bootstrap, revisioned native state, bounded appearance updates and a framework-independent bridge. Host identity is supplied by the entry, never user-agent/request inference. Native fullscreen and web fullscreen are distinct.

The renderer ChromeAdapter consumes WindowChromeBridge. Supply a stable bridge reference per document so appearance revisions survive adapter remounts. Request headers, IPC constants, startup arguments and preference persistence are platform-owned. AppRoot consumes shell/mode/fullscreen seeds rather than a host request object.
