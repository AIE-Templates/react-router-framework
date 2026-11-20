import type { DevelopmentHostOrNone } from "~/main/dev-host.contract.ts";

// What test and release builds bundle in place of ~/main/dev-host.ts (vite.base.config.ts): pages
// come from the utility process, and no development code is in the bundle.

export const developmentHost: DevelopmentHostOrNone = undefined;
