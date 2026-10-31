# Mantine integration

The UI branch pins @mantine/core and @mantine/hooks to 9.7.4. Core remains usable without either.
AppUiProvider mounts VisualMantineProvider inside body. The provider consumes the existing
VisualManager and uses a stable custom color scheme adapter; equal-value subscription feedback
never writes storage again. Each subscription reconciles the current preference immediately,
including changes made before subscription or while effects were disconnected. Clearing the Mantine preference resets only the color scheme.

Core CSS reads data-color-scheme. The UI integration's data-only configuration adds
data-mantine-color-scheme to the same prepaint script and runtime mapping. There is no second
ColorSchemeScript. DirectionProvider renders with the hydration-safe visual snapshot so direction-dependent component
markup matches the server. Its layout-effect bridge adopts the actual client direction before paint
and subscribes to later changes without restoring a default html direction. Application commands
still go through VisualManager.

Static theme and component defaults are centralized in visual/mantine/theme.ts. Motion defaults
use the manager's resolved preference, with zero-duration transitions in reduced mode and CSS
fallback before hydration. Portal interaction surfaces are no-drag; the transparent portal root
is not. The sample exercises Select, Button, Tooltip, Popover, Menu and Modal.

## CSS and script failure

Both CSS entry paths declare theme, base, mantine, components, utilities before registering layers.
The Vite virtual CSS module generates complete shared/light/dark variables from the same merged
theme and custom resolver as the provider. It emits an external production asset; no generated
source is committed. Its selectors match only when both scheme attributes are absent, using a dark
media query for system fallback. Dynamic component states still require JavaScript.

SSR style tags accept the document nonce through AppUiProvider. Static HTML continues to use the
host's actual inline-script hashes. No additional script-src allowance is needed. UI-library CSS
and runtime initialization are validated in production builds, not inferred from unit tests alone.
