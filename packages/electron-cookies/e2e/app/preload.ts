import { contextBridge, ipcRenderer } from "electron";

import { installWindowCookiePreload } from "../../src/preload/index.ts";
import { cookieIpcChannels } from "../../src/shared.ts";

// A sandboxed subframe can live in a separate renderer process. Resolve the same fixture
// configuration in every preload, independently of per-process command-line switches.
const appOrigin: unknown = ipcRenderer.sendSync("fixture:origin");
if (typeof appOrigin !== "string") throw new Error("Missing fixture origin");
const channels = cookieIpcChannels("fixture");
installWindowCookiePreload({
  appOrigin,
  appHost: new URL(appOrigin).hostname,
  prefix: "fixture",
  frame: window,
  isMainFrame: process.isMainFrame,
  ipcRenderer,
  contextBridge,
});

// Passively count deliveries even in frames with no Cookie Store listener.
ipcRenderer.on(channels.changed, () => ipcRenderer.send("fixture:push-observed"));
// Main targets the committed opaque frame after the test has exercised its native cookie
// accessors. Nothing is exposed to page code; report each actual cookie-channel reply.
ipcRenderer.on("fixture:probe-opaque", () => {
  void probeOpaque().catch((error: unknown) =>
    ipcRenderer.send("fixture:opaque-step", { stage: "error", message: String(error) }),
  );
});

async function probeOpaque() {
  ipcRenderer.send("fixture:opaque-step", { stage: "start" });
  const url = appOrigin + "/";
  const text: unknown = ipcRenderer.sendSync(channels.get, url);
  ipcRenderer.send("fixture:opaque-step", { stage: "sync", text });
  const result: unknown = await ipcRenderer.invoke(channels.getAll, url);
  ipcRenderer.send("fixture:opaque-step", { stage: "invoke", result });
}
