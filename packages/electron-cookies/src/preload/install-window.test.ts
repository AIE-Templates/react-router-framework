import type { ExecutionScript, IpcRenderer } from "electron";
import { expect, it, vi } from "vitest";

import { cookieIpcChannels, OMIT_COOKIES_HEADER } from "../shared.ts";
import { installCookieShims } from "./install-cookie-shims.ts";
import { installWindowCookiePreload, type WindowCookiePreloadOptions } from "./install-window.ts";
import { installSubscriptionShims, type SubscriptionBridge } from "./subscriptions.ts";
import type { CookieShimBridge } from "./types.ts";

const appOrigin = "fixture://site";
const channels = cookieIpcChannels("fixture");
const href = appOrigin + "/created";
function setup() {
  const frame = {
    origin: appOrigin,
    location: { protocol: "fixture:", href },
    get parent(): never {
      throw new Error("unavailable");
    },
  };
  const wire = {
    sendSync: vi.fn<(...args: unknown[]) => unknown>(),
    send: vi.fn<(...args: unknown[]) => void>(),
    invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    on: vi.fn<(channel: string, cb: (event: unknown, push: unknown) => void) => void>(),
    off: vi.fn<() => void>(),
  };
  const executeInMainWorld = vi.fn<(script: ExecutionScript) => void>();
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Stand in for the native renderer transport at the injection boundary.
  const ipcRenderer = wire as unknown as IpcRenderer;
  const options: WindowCookiePreloadOptions = {
    frame,
    appOrigin,
    appHost: "site",
    prefix: "fixture",
    isMainFrame: true,
    ipcRenderer,
    contextBridge: { executeInMainWorld },
  };
  function install(): CookieShimBridge {
    installWindowCookiePreload(options);
    return executeInMainWorld.mock.lastCall![0].args![0];
  }
  return { frame, wire, options, install, executeInMainWorld };
}

it("binds each operation to the captured document and registers the filtered receiver before sending", async () => {
  const { wire, frame, executeInMainWorld, install } = setup();
  const bridge = install();
  expect(executeInMainWorld.mock.lastCall![0].func).toBe(installCookieShims);
  expect(bridge.options).toMatchObject({
    creationUrl: href,
    markerHeader: OMIT_COOKIES_HEADER,
    fetch: true,
    cookieApi: true,
  });
  const { documentId } = bridge.options;
  frame.location.href += "/moved";
  wire.sendSync
    .mockReturnValueOnce("name=value")
    .mockReturnValueOnce(null)
    .mockImplementationOnce(() => {
      throw new Error("disconnected");
    });
  expect(bridge.getCookie(frame.location.href)).toBe("name=value");
  expect(bridge.getCookie(href)).toBe("");
  expect(bridge.getCookie(href)).toBe("");
  bridge.setCookie(href, "a=b");
  expect(wire.sendSync.mock.calls).toEqual([
    [channels.get, href],
    [channels.get, href],
    [channels.get, href],
    [channels.set, href, "a=b"],
  ]);
  await bridge.getAll(href, "a");
  const write = {
    name: "a",
    value: "b",
    domain: null,
    path: "/",
    expires: null,
    secure: true,
    partitioned: false,
    sameSite: "strict",
  } as const;
  await bridge.set(href, write);
  expect(wire.invoke.mock.calls).toEqual([
    [channels.getAll, href, "a"],
    [channels.storeSet, href, write],
  ]);
  const receive = vi.fn<() => void>();
  bridge.registerChanges(href, documentId, receive);
  expect(wire.on.mock.invocationCallOrder[0]).toBeLessThan(wire.send.mock.invocationCallOrder[0]);
  expect(wire.send).toHaveBeenCalledExactlyOnceWith(channels.register, href, documentId);
  const [channel, deliver] = wire.on.mock.calls[0];
  expect(channel).toBe(channels.changed);
  const push = { documentId, changed: [], deleted: [] };
  deliver({}, { ...push, documentId: "previous" });
  deliver({}, push);
  expect(receive).toHaveBeenCalledExactlyOnceWith(push);
  expect(install().options.documentId).not.toBe(documentId);
});

it("selects opaque, blob and srcdoc installations without registering unused cookie channels", () => {
  const { options, frame, wire, install, executeInMainWorld } = setup();
  options.isMainFrame = false;
  frame.origin = "null";
  installWindowCookiePreload(options);
  expect(executeInMainWorld).not.toHaveBeenCalled();
  frame.origin = appOrigin;
  frame.location = { protocol: "blob:", href: "blob:" + href };
  expect(install().options).toMatchObject({ cookieApi: false, fetch: true, creationUrl: null });
  frame.location = { protocol: "about:", href: "about:srcdoc" };
  expect(install().options).toMatchObject({ cookieApi: false, fetch: true, creationUrl: null });
  expect(wire.on).not.toHaveBeenCalled();
  expect(wire.sendSync).not.toHaveBeenCalled();
});

it("binds registration operations from a window to the same isolated document for grant and completion", async () => {
  const { install, wire, executeInMainWorld } = setup();
  const {
    options: { documentId },
  } = install();
  const script = executeInMainWorld.mock.calls.find(([entry]) => entry.func === installSubscriptionShims)![0];
  const subscriptions: SubscriptionBridge = script.args![0];
  const scope = appOrigin + "/";
  const operation = { kind: "unregister" } as const;
  wire.invoke.mockResolvedValueOnce({ operationId: "op" }).mockResolvedValueOnce(undefined);
  const { operationId } = await subscriptions.acquire(scope, operation);
  await subscriptions.complete(operationId, true);
  expect(wire.invoke.mock.calls).toEqual([
    [channels.acquire, documentId, scope, operation],
    [channels.complete, documentId, "op", true],
  ]);
});
