import type { ColorSchemeSnapshot, VisualPreferences } from "./visual/types";
export interface ManagersInitialState {
  visual?: VisualPreferences;
  externalColorScheme?: ColorSchemeSnapshot;
}
