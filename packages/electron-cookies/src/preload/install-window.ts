import type { ContextBridge, IpcRenderer } from "electron";

import { cookieIpcChannels, OMIT_COOKIES_HEADER, type CookiePush } from "../shared.ts";
import { prepareCookieFrame } from "./frame.ts";
import { installCookieShims } from "./install-cookie-shims.ts";
import type { CookieShimBridge } from "./types.ts";

export interface WindowCookiePreloadOptions {
  appOrigin: string;
  appHost: string;
  prefix: string;
  frame: Parameters<typeof prepareCookieFrame>[1];
  isMainFrame: boolean;
  ipcRenderer: Pick<IpcRenderer, "sendSync" | "invoke" | "on" | "off" | "send">;
  contextBridge: Pick<ContextBridge, "executeInMainWorld">;
}

export function installWindowCookiePreload({
  appOrigin,
  appHost,
  prefix,
  frame,
  isMainFrame,
  ipcRenderer,
  contextBridge,
}: WindowCookiePreloadOptions): void {
  const installation = prepareCookieFrame(appOrigin, frame, isMainFrame);
  if (!installation.fetch && !installation.cookieApi) return;
  const { creationUrl } = installation;
  const documentId = crypto.randomUUID();
  const channels = cookieIpcChannels(prefix);
  const bridge: CookieShimBridge = {
    options: { ...installation, appOrigin, appHost, documentId, markerHeader: OMIT_COOKIES_HEADER },
    getCookie() {
      try {
        const reply: unknown = ipcRenderer.sendSync(channels.get, creationUrl);
        return typeof reply === "string" ? reply : "";
      } catch {
        return "";
      }
    },
    setCookie(_url, text) {
      try {
        ipcRenderer.sendSync(channels.set, creationUrl, text);
      } catch {
        // document.cookie setters have no error return.
      }
    },
    getAll: (_url, name) => ipcRenderer.invoke(channels.getAll, creationUrl, name),
    set: (_url, cookie) => ipcRenderer.invoke(channels.storeSet, creationUrl, cookie),
    registerChanges(_url, _id, receive) {
      const listener = (_event: unknown, push: CookiePush) => {
        if (push.documentId === documentId) receive(push);
      };
      ipcRenderer.on(channels.changed, listener);
      try {
        ipcRenderer.send(channels.register, creationUrl, documentId);
      } catch (err) {
        ipcRenderer.off(channels.changed, listener);
        throw err;
      }
    },
  };
  contextBridge.executeInMainWorld({ func: installCookieShims, args: [bridge] });
}
