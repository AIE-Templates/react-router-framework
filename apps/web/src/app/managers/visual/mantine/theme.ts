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
  },
});
export const resolvedVisualTheme = mergeMantineTheme(DEFAULT_THEME, visualTheme);
export const visualVariables: CSSVariablesResolver = () => ({
  variables: {},
  light: { "--mantine-color-body": "var(--background)", "--mantine-color-text": "var(--foreground)" },
  dark: { "--mantine-color-body": "var(--background)", "--mantine-color-text": "var(--foreground)" },
});
