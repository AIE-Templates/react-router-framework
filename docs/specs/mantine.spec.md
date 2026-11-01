# Mantine integration

The UI branch pins @mantine/core, @mantine/hooks, @mantine/modals, @mantine/notifications and
@mantine/form to 9.7.4. Core remains usable without any of them.
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
is not. The sample exercises Select, Button, Tooltip, Popover, Menu, Modal, a confirm modal and a
notification; notifications are no-drag and follow the reduced-motion CSS.

## Source and style ownership

The reusable VisualSettings panel and its tests live in components/appearance-settings; its
colocated CSS Module uses the components layer. Native-control defaults in base.css and the panel
module exclude Mantine classes, so they do not override the library's input and button styles.
The demo preserves the Mantine TextInput while using Core's feature-local module classes and
stable data-demo controls. Ordinary UI tests use testing/render.tsx, which already composes the
Mantine AppUiProvider through the shared slot.

The global entry styles/index.css imports styles/ui.css, which owns the Mantine core/notification
imports and library integration rules. Core tokens, base and shell rules live in styles/; demo
rules stay in feature modules. Shared Sass/PostCSS configuration is in place for Mantine SCSS
Modules while inherited Core modules remain CSS.

## Modals, notifications and forms

AppUiProvider composes ModalsProvider and the single Notifications host directly inside
VisualMantineProvider, so `modals.*` and `notifications.*` work from any route or event handler.
Do not render another Notifications component. Modals opened through the manager reuse the Modal
theme defaults. Static Notifications/Notification defaults live in theme.ts; the provider adds the
motion-dependent transition duration and a direction-aware position (bottom-right, bottom-left in
RTL). Notifications render only after mount, so these values cannot affect hydration. Context modals
can be registered later through ModalsProvider `modals` with `MantineModalsOverride` augmentation.
Notification styles are imported as `styles.layer.css` after core styles; modals and form ship no
CSS. @mantine/form needs no provider. The sample menu exercises a confirm modal and notification.

## CSS and script failure

Both CSS entry paths declare theme, base, mantine, components, utilities before registering layers.
The Vite virtual CSS module generates complete shared/light/dark variables from the same merged
theme and custom resolver as the provider. It emits an external production asset; no generated
source is committed. Its selectors match only when both scheme attributes are absent, using a dark
media query for system fallback. Dynamic component states still require JavaScript.

SSR style tags accept the document nonce through AppUiProvider. Static HTML continues to use the
host's actual inline-script hashes. No additional script-src allowance is needed. UI-library CSS
and runtime initialization are validated in production builds, not inferred from unit tests alone.

## Shared style configuration

`vite-plugins/styles.ts` supplies identical Sass injection and module naming to Vite and Vitest. `_mantine.scss` contains tools only, with breakpoints configured from `config/breakpoints.ts`; existing Core modules remain CSS. The build integration test in `vite-plugins/styles-pipeline.test.ts` compiles disposable fixtures through the project PostCSS configuration, including a separate preset expansion probe.

`styles/ui.css` owns Mantine package styles, focus-ring color, reduced-motion and no-drag rules. Both palettes derive semantic colors from Core tokens; font families, default radius and breakpoints use the same application sources. `vite-plugins/visual-fallback.ts` loads the dynamic generator with Vite's module runner so application aliases resolve, and registers its dependencies for invalidation. It never ships a frozen copy of theme variables.
