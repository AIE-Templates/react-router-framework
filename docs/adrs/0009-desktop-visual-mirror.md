# Keep desktop visual persistence separate from generic preferences

Status: Accepted

## Decision

Use a dedicated validated IPC and versioned visual-theme.json mirror. Core remains authoritative; native synchronization reports background, overlay and persistence separately. The main process composes persistent declarative overlay overrides above a theme layer. It does not change nativeTheme.themeSource.

## Rationale

A separate file avoids special keys in the generic preference table and prevents accidental header disclosure. Theme and override layers avoid asynchronous ordering conflicts. Keeping the native theme source on system preserves renderer media-query semantics and avoids process-wide effects on unrelated native surfaces.

## Consequences

The initial native background may use an older mirror until renderer synchronization. Persistence failures are explicit and retryable. Native menus and dialogs continue to follow the OS. macOS overlay color support is independent of window background support.
