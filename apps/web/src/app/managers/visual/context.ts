import { createContext } from "react";

import type { VisualManager } from "./manager";
export const VisualManagerContext = createContext<VisualManager | null>(null);
