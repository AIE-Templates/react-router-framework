import { createContext } from "react";

import type { createWindowChromeRuntime } from "./runtime";

export const EnvironmentContext = createContext<ReturnType<typeof createWindowChromeRuntime> | null>(null);
