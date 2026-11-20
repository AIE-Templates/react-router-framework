import { DEV_ENV } from "~/debug-env.names.ts";
import type { DevelopmentHostOrNone } from "~/main/dev-host.contract.ts";

import { createDevProxyFetch } from "./dev-proxy.ts";

// The development-only code of the main process, in the dev build. Test and release builds bundle
// ~/main/dev-host.empty.ts instead (vite.base.config.ts), so neither this file nor dev-proxy.ts is
// in them. Import it as `~/main/dev-host.ts`, the specifier the build replaces. It is also the only
// reader of the dev build's own environment variable, named in ~/debug-env.names.ts.

// vite.base.config.ts refuses to build the dev profile without the address.
if (DESKTOP_DEV_SERVER_URL === undefined) throw new Error("The dev build has no development server address");

export const developmentHost: DevelopmentHostOrNone = {
  serverUrl: DESKTOP_DEV_SERVER_URL,
  createFetch: createDevProxyFetch,
  onReloadRequest(reload) {
    // scripts/dev.ts writes "reload" on stdin when the preload script was rebuilt.
    process.stdin.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("reload")) reload();
    });
  },
  userDataSuffix: process.env[DEV_ENV.userDataSuffix] || undefined,
};
