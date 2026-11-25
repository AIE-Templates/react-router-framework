import { contextBridge, ipcRenderer } from "electron";

import { installServiceWorkerCookiePreload, installWindowCookiePreload } from "../../src/preload/index.ts";
import { cookieIpcChannels } from "../../src/shared.ts";

declare const fixtureAppOrigin: string;
const channels = cookieIpcChannels("fixture");
if (process.type === "service-worker") {
  installServiceWorkerCookiePreload({
    appOrigin: fixtureAppOrigin,
    appHost: "app",
    prefix: "fixture",
    ipcRenderer,
    contextBridge,
  });
  ipcRenderer.on("fixture:probe-worker", () => {
    void ipcRenderer.invoke(channels.getAll, "private-probe").then(
      (reply: unknown) => ipcRenderer.send("fixture:worker-probe-result", { reply }),
      (error: unknown) => ipcRenderer.send("fixture:worker-probe-result", { error: String(error) }),
    );
  });
} else {
  // Main records each live frame preload for the opaque-frame test.
  const appOrigin: unknown = ipcRenderer.sendSync("fixture:origin");
  if (typeof appOrigin !== "string") throw new Error("Missing fixture origin");
  if (window.name === "registration-method-probe") {
    contextBridge.executeInMainWorld({
      func: () => {
        // Compare identities before and after install, including wrappers with native-looking toString().
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- Serialized into the renderer.
        const methods = () => [
          // oxlint-disable-next-line typescript/unbound-method -- Snapshot the getter without invoking it.
          Object.getOwnPropertyDescriptor(ServiceWorkerRegistration.prototype, "cookies")!.get,
          Object.getOwnPropertyDescriptor(ServiceWorkerRegistration.prototype, "unregister")!.value,
          Object.getOwnPropertyDescriptor(CookieStoreManager.prototype, "subscribe")!.value,
          Object.getOwnPropertyDescriptor(CookieStoreManager.prototype, "unsubscribe")!.value,
        ];
        const originals = methods();
        window.fixtureNativeRegistrationMethods = () => methods().map((method, i) => method === originals[i]);
      },
    });
  }
  installWindowCookiePreload({
    appOrigin,
    appHost: "app",
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
    void probeOpaque(appOrigin).catch((error: unknown) =>
      ipcRenderer.send("fixture:opaque-step", { stage: "error", message: String(error) }),
    );
  });
}

async function probeOpaque(appOrigin: string) {
  ipcRenderer.send("fixture:opaque-step", { stage: "start" });
  const url = appOrigin + "/";
  const text: unknown = ipcRenderer.sendSync(channels.get, url);
  ipcRenderer.send("fixture:opaque-step", { stage: "sync", text });
  const result: unknown = await ipcRenderer.invoke(channels.getAll, url);
  ipcRenderer.send("fixture:opaque-step", { stage: "invoke", result });
}

declare global {
  interface Window {
    fixtureNativeRegistrationMethods(): boolean[];
  }
}
