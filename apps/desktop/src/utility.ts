import { fromElectronPort, type PortServer, servePort } from "@repo/port-fetch";
import { shellFromEnv } from "@repo/shared";
import { createWebApp, logStreamFailure, rethrowNonErrors } from "web/build/server/index.js";

import { withBenchRoutes } from "./bench-routes.ts";
import { E2E_PREFIX, e2eRoutes } from "./e2e-routes.ts";
import { portAckCoalesce } from "./port-options.ts";
import { SMOKE_PREFIX, smokeRoutes } from "./smoke-routes.ts";

// The utility process: the whole web app (createWebApp(): the API, static files, React Router SSR)
// served over the MessagePortMain the main process sends, no TCP port. Everything is bundled into
// this one ES module; only Node built-ins are external.

const shell = shellFromEnv(process.env);
// The main process sets DESKTOP_SMOKE only when it runs the smoke and DESKTOP_E2E only for a
// Playwright run (it clears both otherwise), which add the /__smoke/* or /__e2e/* endpoints inside
// the web app's chain.
const smoke = process.env.DESKTOP_SMOKE === "1";
const e2e = process.env.DESKTOP_E2E === "1";
const web = createWebApp({
  shell,
  clientDir: process.env.CLIENT_DIR,
  ...(smoke || e2e
    ? {
        extend: (app) => {
          if (smoke) app.route(SMOKE_PREFIX, smokeRoutes({ rethrowNonErrors, logStreamFailure }));
          if (e2e) app.route(E2E_PREFIX, e2eRoutes());
        },
      }
    : {}),
});
// The main process sets both: the same ack coalescing as its end, and DESKTOP_BENCH only for an
// unpackaged benchmark run (it clears it otherwise), which adds the /__bench/* endpoints.
const ackCoalesce = portAckCoalesce(process.env.DESKTOP_PORT_ACK_COALESCE);
let server: PortServer | undefined;
const handler =
  process.env.DESKTOP_BENCH === "1"
    ? withBenchRoutes(
        (request) => web.fetch(request),
        () => server?.stats(),
      )
    : (request: Request) => web.fetch(request);

process.parentPort.on("message", (event) => {
  const message: unknown = event.data;
  if (!isMessage(message)) return;
  if (message.type === "port") {
    const [port] = event.ports;
    if (!port) return;
    server?.close();
    server = servePort(fromElectronPort(port), handler, ackCoalesce ? { ackCoalesce } : {});
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- the parent process port, not a window
    process.parentPort.postMessage({ type: "ready", shell: shell.kind, uptimeMs: process.uptime() * 1000 });
  } else if (message.type === "shutdown") {
    server?.close();
    process.exit(0);
  }
});

function isMessage(value: unknown): value is { type: string } {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}
