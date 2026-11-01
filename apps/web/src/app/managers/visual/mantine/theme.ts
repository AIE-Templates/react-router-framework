import { createTheme, DEFAULT_THEME, mergeMantineTheme, type CSSVariablesResolver } from "@mantine/core";

import { BREAKPOINTS } from "~/config/breakpoints";

export const visualTheme = createTheme({
  primaryColor: "gray",
  defaultRadius: "md",
  fontFamily: "var(--app-font-sans)",
  headings: { fontFamily: "var(--app-font-sans)" },
  radius: { ...DEFAULT_THEME.radius, md: "var(--app-radius)" },
  breakpoints: BREAKPOINTS,
  focusRing: "auto",
  respectReducedMotion: false,
  components: {
    Popover: { defaultProps: { shadow: "md", radius: "md" } },
    Menu: { defaultProps: { shadow: "md", radius: "md" } },
    Modal: { defaultProps: { shadow: "lg", radius: "md" } },
    // Read by the single <Notifications /> host in AppUiProvider; position follows direction in the provider.
    Notifications: { defaultProps: { limit: 5, autoClose: 4000, pauseResetOnHover: "notification" } },
    Notification: { defaultProps: { radius: "md", withBorder: true } },
  },
});
export const resolvedVisualTheme = mergeMantineTheme(DEFAULT_THEME, visualTheme);
export const visualVariables: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    "--mantine-color-body": "var(--app-color-background)",
    "--mantine-color-text": "var(--app-color-foreground)",
    "--mantine-color-bright": "var(--app-color-foreground)",
    "--mantine-color-default-color": "var(--app-color-foreground)",
    "--mantine-color-dimmed": "var(--app-color-muted-foreground)",
    "--mantine-color-placeholder": "var(--app-color-muted-foreground)",
    "--mantine-color-default": "var(--app-color-card)",
    "--mantine-color-default-hover": "var(--app-color-muted)",
    "--mantine-color-default-border": "var(--app-color-input)",
  },
  dark: {
    "--mantine-color-body": "var(--app-color-background)",
    "--mantine-color-text": "var(--app-color-foreground)",
    "--mantine-color-bright": "var(--app-color-foreground)",
    "--mantine-color-default-color": "var(--app-color-foreground)",
    "--mantine-color-dimmed": "var(--app-color-muted-foreground)",
    "--mantine-color-placeholder": "var(--app-color-muted-foreground)",
    "--mantine-color-default": "var(--app-color-card)",
    "--mantine-color-default-hover": "var(--app-color-muted)",
    "--mantine-color-default-border": "var(--app-color-input)",
  },
});
