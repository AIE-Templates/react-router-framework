import type { VisualPreferences, VisualRecord } from "@repo/shared";

export interface VisualState {
  readonly preferences: Readonly<Partial<VisualPreferences>>;
  readonly resolved: Readonly<{ colorScheme: "light" | "dark"; direction: "ltr" | "rtl"; reducedMotion: boolean }>;
}
export type StoreStatus = "ok" | "failed" | "unavailable" | "absent";
export interface VisualStatus {
  readonly initialized: boolean;
  readonly storage: Readonly<Record<"local" | "cookie" | "native", StoreStatus>>;
}

export interface VisualBootstrapConfig {
  storageKey: string;
  bootstrapKey: "frameworkVisualBootstrap";
  cookieName?: string;
  additionalColorSchemeAttributes: readonly string[];
}
export interface VisualBootstrapRecord {
  storageKey: string;
  record?: VisualRecord;
  fixedAppearance?: "light" | "dark";
  state: VisualState;
}

export interface NativeVisualSource {
  /** Self-contained reader of preload's document-start snapshot. */
  prepaint: (host: Window) => { record: string | null; fixedAppearance?: "light" | "dark" } | undefined;
  /** Live bridge discovery. Called on connection and when re-probing unavailable stores. */
  connect(host: Window):
    | {
        read(): { record: string | null; pending: boolean; fixedAppearance?: "light" | "dark" };
        push(raw: string): Promise<Exclude<StoreStatus, "absent">>;
      }
    | undefined;
}

declare global {
  interface Window {
    frameworkVisualBootstrap?: VisualBootstrapRecord;
  }
}
