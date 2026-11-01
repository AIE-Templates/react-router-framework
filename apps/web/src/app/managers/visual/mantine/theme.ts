import { createTheme, DEFAULT_THEME, mergeMantineTheme, type CSSVariablesResolver } from "@mantine/core";
export const visualTheme = createTheme({
  primaryColor: "gray",
  defaultRadius: "md",
  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
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
  },
  dark: {
    "--mantine-color-body": "var(--app-color-background)",
    "--mantine-color-text": "var(--app-color-foreground)",
  },
});
