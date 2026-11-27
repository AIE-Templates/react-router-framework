import type { Shell } from "@repo/shared";
import { createContext } from "react";

import type { ChromeState } from "~/platform/chrome-adapter/runtime";

export interface AppEnvironment {
  readonly shell: Shell;
  readonly chrome: ChromeState;
}

export const EnvironmentContext = createContext<AppEnvironment | null>(null);
