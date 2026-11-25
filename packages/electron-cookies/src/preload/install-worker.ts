import { cookieIpcChannels, OMIT_COOKIES_HEADER, type WorkerCookieEvent } from "../shared.ts";
import { installCookieShims } from "./install-cookie-shims.ts";
import type { WindowCookiePreloadOptions } from "./install-window.ts";
import { installSubscriptionShims, type SubscriptionBridge } from "./subscriptions.ts";
import type { WorkerStoreBridge } from "./types.ts";
import { installWorkerEvents, type WorkerEventBridge } from "./worker-events.ts";

export interface ServiceWorkerCookiePreloadOptions extends Pick<
  WindowCookiePreloadOptions,
  "appOrigin" | "appHost" | "prefix" | "contextBridge"
> {
  ipcRenderer: Pick<WindowCookiePreloadOptions["ipcRenderer"], "invoke" | "on" | "send">;
}

export function installServiceWorkerCookiePreload({
  appOrigin,
  appHost,
  prefix,
  ipcRenderer,
  contextBridge,
}: ServiceWorkerCookiePreloadOptions): void {
  // registration and location belong to the worker main world, not the preload realm.
  const { scopeOrigin, scriptUrl }: { scopeOrigin: string; scriptUrl: string } = contextBridge.executeInMainWorld({
    func: () => {
      const registration: ServiceWorkerRegistration = Reflect.get(self, "registration");
      const scope = new URL(registration.scope);
      return { scopeOrigin: scope.protocol + "//" + scope.host, scriptUrl: self.location.href };
    },
  });
  if (scopeOrigin !== appOrigin) return;
  const channels = cookieIpcChannels(prefix);
  const store: WorkerStoreBridge = {
    options: {
      cookieApi: true,
      fetch: true,
      creationUrl: scriptUrl,
      documentId: "",
      appOrigin,
      appHost,
      markerHeader: OMIT_COOKIES_HEADER,
    },
    getAll: (url, name) => ipcRenderer.invoke(channels.getAll, name, url),
    set: (_url, cookie) => ipcRenderer.invoke(channels.storeSet, cookie),
  };
  const subscriptions: SubscriptionBridge = {
    acquire: (targetScope, operation) => ipcRenderer.invoke(channels.acquire, targetScope, operation),
    complete: (id, success) => ipcRenderer.invoke(channels.complete, id, success),
  };
  const events: WorkerEventBridge = {
    listen(deliver, finish) {
      ipcRenderer.on(channels.deliver, (_event, message: WorkerCookieEvent) => deliver(message));
      ipcRenderer.on(channels.finish, (_event, id: string) => finish(id));
    },
    started: (id) => ipcRenderer.send(channels.started, id),
    ack: (id) => ipcRenderer.send(channels.ack, id),
    nack: (id) => ipcRenderer.send(channels.nack, id),
  };
  contextBridge.executeInMainWorld({ func: installCookieShims, args: [store] });
  contextBridge.executeInMainWorld({ func: installSubscriptionShims, args: [subscriptions] });
  contextBridge.executeInMainWorld({ func: installWorkerEvents, args: [events] });
}
