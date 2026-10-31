# Desktop visual synchronization

Core VisualManager is authoritative for renderer preferences. DesktopVisualSync is composed in the Electron root within AppRoot; registries remain platform-independent. It waits for the environment runtime to report available desktop enhancement, then checks the dedicated syncVisualTheme capability. New renderer platform adapters live in app/platform/electron; existing generic preference helpers remain in app/lib.

The dedicated IPC validates sender, preference enum, document token and increasing request revision. It returns separate background, overlay and persistence outcomes. No loader revalidation or general preference mutation occurs. Late results cannot update a disconnected adapter. useDesktopVisualStatus reports pending, unsupported, processed or rejected status without claiming that a page change implies durable native persistence.

The main process persists only a versioned colorScheme preference to visual-theme.json, using the shared durable temporary-write and rename helpers. Missing, corrupt or unknown-version mirrors use auto. Failed writes preserve the last durable mirror and are retryable. No legacy theme migration is performed. Generic prefs.json, request headers and cookie storage do not contain this mirror.

Window background follows the theme on all platforms. Overlay colors follow it only for Windows/Linux native-overlay windows. macOS and system-decorated overlay updates are unsupported independently of background and persistence success. Explicit modes ignore native theme changes; auto resumes current system resolution immediately. nativeTheme.themeSource remains system: native menus, dialogs and controls follow the OS, not the application preference. Direction and reduced motion remain renderer preferences.

Theme and overlay layers compose according to the window chrome specification. Native state never writes back into Core preferences. Restart uses the durable mirror before window creation; the connected page then synchronizes its current authoritative preference.
