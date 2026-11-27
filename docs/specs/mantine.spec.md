# Mantine integration

The UI branch pins @mantine/core, @mantine/hooks, @mantine/modals, @mantine/notifications and
@mantine/form to 9.7.4. Core remains usable without any of them.
`AppUiProvider` mounts `VisualMantineProvider` inside the body. During SSR and the first hydration
render, the color scheme adapter reads the effective preference from the VisualManager server snapshot
seeded by the request cookie. Each subscription immediately delivers the effective client preference
and follows subsequent changes. This also picks up changes made before subscription or while effects
were disconnected. Mantine takes its `defaultColorScheme` from `VISUAL_DEFAULTS.colorScheme`.
Prepaint and the first connection each select the first valid startup source in upstream order
(native mirror in Electron, cookie in SSR, then local storage). The first connection repairs differing
sources with the selected record and its original stamp. With no valid source, it uses defaults and
writes nothing. A command committed before connection switches that reconciliation to runtime ordering.
In Electron, prepaint reads the window's fixed appearance from the per-window sample main returns to
preload. After hydration, Mantine subscribes to VisualManager state for the fixed window appearance. If a
live native read supplies or clears the override on connect or retry, `forceColorScheme` follows it even
when storage status stays the same. The window override leaves the shared preference record intact; the
appearance panel still edits the global preference, which synchronizes to the desktop mirror.

The effective preference combines the sparse record with the product defaults and can be `auto`.
Mantine's `setColorScheme` writes only when its argument differs from that preference, so mounting
with defaults and receiving subscription updates leave storage untouched. To record an explicit user
choice equal to the default, call `visual.actions.setColorSchemePreference(value)`.
Mantine's `clearColorScheme` removes only the color scheme field and restores the product default.
If a concurrent record wins during either command, the adapter corrects Mantine's optimistic
preference to match the effective winner, even when Core's effective preference stays the same.

Core CSS reads data-color-scheme. The UI integration's data-only configuration adds
data-mantine-color-scheme to the same prepaint script and runtime mapping. Core owns both root
attributes through hydration so Mantine’s mount effects preserve the prepaint result. There is no second
ColorSchemeScript. DirectionProvider renders with the hydration-safe visual snapshot so direction-dependent component
markup matches the server. Its layout-effect bridge adopts the actual client direction before paint
and subscribes to later changes without restoring a default html direction. Application commands
still go through VisualManager.

Static theme and component defaults are centralized in visual/mantine/theme.ts. Motion defaults
use the manager's resolved preference, with zero-duration transitions in reduced mode and CSS
fallback before hydration. Both the explicit reduced preference and the system fallback disable the
loading Button transitions on its root, `::before`, inner element and loader. Global no-drag styles
cover portal interaction surfaces, including Select and Combobox dropdowns and Modal content.
The transparent portal root stays outside the rule. The sample exercises Select, Button, Tooltip, Popover, Menu, Modal, a confirm modal and a
notification; notifications are no-drag and follow the reduced-motion CSS.

## Source and style ownership

The reusable VisualSettings panel and its tests live in components/appearance-settings; its
colocated CSS Module styles only the fieldset layout and surface in the components layer. Native
controls opt in to the defaults in `styles/base.css` with `[data-native-control]`.
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
media query for system fallback. The default Mantine Input wrapper takes its surface, border and
focus border from `--app-color-card`, `--app-color-input` and `--app-color-ring` while both attributes
are absent, preserving the keyboard focus indicator even with scripts blocked. Dynamic component states still require JavaScript.

SSR style tags accept the document nonce through AppUiProvider. Static HTML continues to use the
host's actual inline-script hashes. No additional script-src allowance is needed. UI-library CSS
and runtime initialization are validated in production builds, not inferred from unit tests alone.

## Shared style configuration

`vite-plugins/styles.ts` supplies identical Sass injection and module naming to Vite and Vitest. `_mantine.scss` contains tools only, with breakpoints configured from `config/breakpoints.ts`; existing Core modules remain CSS. The build integration test in `vite-plugins/styles-pipeline.test.ts` compiles disposable fixtures through the project PostCSS configuration, including a separate preset expansion probe.

`styles/ui.css` owns Mantine package styles, focus-ring color, reduced-motion and no-drag rules. The resolver applies the same nine Core color token mappings in both its light and dark sections to override Mantine's scheme-specific defaults. Font families, default radius and breakpoints use the same application sources. `vite-plugins/visual-fallback.ts` loads the dynamic generator with Vite's module runner so application aliases resolve, and registers its dependencies for invalidation. It never ships a frozen copy of theme variables.
