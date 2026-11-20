import { fromElectronPort, type PortServer, servePort } from "@repo/port-fetch";
import { shellFromEnv } from "@repo/shared";
import { createWebApp, logStreamFailure, rethrowNonErrors } from "web/build/server/index.js";

// These two are replaced in release builds (vite.base.config.ts): import them by exactly these names.
import { readDebugEnv } from "~/debug-env.ts";
import { selectUtilityDiagnostics } from "~/diagnostics/entry.ts";

// The utility process: the whole web app (createWebApp(): the API, static files, React Router SSR)
// served over the MessagePortMain the main process sends, no TCP port. Everything is bundled into
// this one ES module; only Node built-ins are external.

const shell = shellFromEnv(process.env);
// Dev and test builds: the main process sets the debug variables that concern this process (it
// clears the run flags it did not select): which of the /__smoke/*, /__e2e/* and /__bench/*
// endpoints to add, and the same ack coalescing as its end. A release build reads none of them and
// has no such endpoints (~/debug-env.ts, ~/diagnostics/entry.ts).
const debug = readDebugEnv();
const diagnostics = selectUtilityDiagnostics(debug, { rethrowNonErrors, logStreamFailure });
// The smoke's and the end-to-end tests' endpoints go inside the web app's chain, the benchmark's in
// front of it.
const web = createWebApp({
  shell,
  clientDir: process.env.CLIENT_DIR,
  ...(diagnostics.extend ? { extend: diagnostics.extend } : {}),
});
const ackCoalesce = debug.ackCoalesce();
let server: PortServer | undefined;
const handler = diagnostics.wrap(
  (request) => web.fetch(request),
  () => server?.stats(),
);

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
