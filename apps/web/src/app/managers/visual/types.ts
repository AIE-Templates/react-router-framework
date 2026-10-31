export interface VisualPreferences {
  colorScheme: "auto" | "light" | "dark";
  direction: "ltr" | "rtl";
  reducedMotion: "auto" | "reduce" | "full";
}
export interface VisualState {
  readonly preferences: Readonly<VisualPreferences>;
  readonly resolved: Readonly<{ colorScheme: "light" | "dark"; direction: "ltr" | "rtl"; reducedMotion: boolean }>;
}
export interface VisualStatus {
  readonly initialized: boolean;
  readonly persistence: "unavailable" | "ready" | "saved" | "failed" | "unsupported-version";
}
export const DEFAULT_VISUAL_PREFERENCES: Readonly<VisualPreferences> = {
  colorScheme: "auto",
  direction: "ltr",
  reducedMotion: "auto",
};
export interface VisualBootstrapConfig {
  storageKey: string;
  bootstrapKey: string;
  additionalColorSchemeAttributes: readonly string[];
}
export interface VisualBootstrapRecord {
  version: 1;
  storageKey: string;
  state: VisualState;
  persistence: VisualStatus["persistence"];
}

declare global {
  interface Window {
    frameworkVisualBootstrap?: VisualBootstrapRecord;
  }
}
