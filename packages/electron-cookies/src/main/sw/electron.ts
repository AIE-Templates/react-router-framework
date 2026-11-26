import type { IpcMainInvokeEvent, ServiceWorkerMain, ServiceWorkers } from "electron";

import { invokeCookieStore, publicChange, type CookieIpcOptions } from "../../ipc.ts";
import { cookieIpcChannels, type SubscriptionOperation, type WorkerCookieItem } from "../../shared.ts";
import { CookieWorkerManager, type WakeStorage } from "./cookie-worker-manager.ts";
import { checkSubscriptionCount } from "./wake-index.ts";

export interface CookieWorkerIpcOptions extends CookieIpcOptions {
  serviceWorkers: Pick<ServiceWorkers, "on" | "getAllRunning" | "getWorkerFromVersionID" | "startWorkerForScope">;
  storage: WakeStorage;
  /** Maximum wait for each worker start. Defaults to 60 seconds. */
  wakeTimeoutMs?: number;
  /** Maximum lifetime of an outstanding cookie event. Defaults to five minutes. */
  taskTimeoutMs?: number;
  /** Maximum wait for wake-index writes during quit. Defaults to two seconds. */
  quitTimeoutMs?: number;
}

function validateOperation(scope: string, input: unknown): SubscriptionOperation {
  if (!input || typeof input !== "object" || !("kind" in input)) throw new TypeError("Invalid subscription operation");
  const { kind } = input;
  if (kind === "unregister") return { kind };
  if (
    (kind !== "subscribe" && kind !== "unsubscribe") ||
    !("subscriptions" in input) ||
    !Array.isArray(input.subscriptions)
  )
    throw new TypeError("Invalid subscription operation");
  if (kind === "subscribe") checkSubscriptionCount(input.subscriptions.length);
  const subscriptions = input.subscriptions.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new TypeError("Invalid subscription");
    const name = "name" in entry ? entry.name : undefined;
    const url = "url" in entry ? entry.url : undefined;
    if (
      (name !== undefined && typeof name !== "string") ||
      (url !== undefined && (typeof url !== "string" || !URL.canParse(url) || !new URL(url).href.startsWith(scope)))
    )
      throw new TypeError("Invalid subscription");
    return { name, url };
  });
  return { kind, subscriptions };
}

export function installCookieWorkerIpc({
  serviceWorkers,
  storage,
  wakeTimeoutMs,
  taskTimeoutMs,
  quitTimeoutMs,
  changes,
  jar: { script },
  ipcMain,
  prefix,
  isAppUrl,
  ownsSender,
  log,
}: CookieWorkerIpcOptions): { quitAll(): Promise<void> } {
  // Electron exposes notification order, without a store commit timestamp.
  let sequence = 0;
  const now = () => ++sequence;
  const channels = cookieIpcChannels(prefix);
  const running = new Map<number, ServiceWorkerMain>();
  const installed = new WeakSet<ServiceWorkerMain>();
  const manager = new CookieWorkerManager<WorkerCookieItem>({
    storage,
    wakeTimeoutMs,
    taskTimeoutMs,
    quitTimeoutMs,
    logger: {
      warn(fields, message) {
        if (!("scope" in fields)) return log.warn(fields, message);
        const url = new URL(fields.scope);
        log.warn({ ...fields, scope: url.protocol + "//" + url.host + url.pathname }, message);
      },
    },
    scheduler: {
      now,
      after(ms, callback) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    },
    native: {
      async startWorkerForScope(scope) {
        if (!isAppUrl(scope)) return null;
        // Electron reports both absent registrations and transient failures with the same
        // rejection. Only a definitive absence may remove a hint.
        const worker = await serviceWorkers.startWorkerForScope(scope);
        if (!worker || worker.isDestroyed() || !isAppUrl(worker.scope)) throw new Error("Cookie worker unavailable");
        return {
          versionId: worker.versionId,
          scope: worker.scope,
          startTask: () => worker.startTask(),
          send: (event) => worker.send(channels.deliver, event),
          finish: (eventId) => worker.send(channels.finish, eventId),
        };
      },
    },
  });

  function attach(versionId: number) {
    const worker = serviceWorkers.getWorkerFromVersionID(versionId);
    if (!worker || worker.isDestroyed() || !isAppUrl(worker.scope)) return;
    running.set(versionId, worker);
    if (installed.has(worker)) return;
    installed.add(worker);
    const current = () =>
      running.get(versionId) === worker &&
      !worker.isDestroyed() &&
      isAppUrl(worker.scope) &&
      isAppUrl(worker.scriptURL);
    worker.ipc.handle(channels.getAll, (_event, name: unknown, requested: unknown) =>
      invokeCookieStore(current() ? worker.scriptURL : undefined, (url, signal) => {
        if (name !== undefined && typeof name !== "string") throw new TypeError("Invalid cookie name");
        // An omitted URL always reads the browser-owned script URL, even if the
        // registration controls a different directory via Service-Worker-Allowed.
        if (requested === undefined || requested === url) return script.readAll(url, name, signal);
        // Blink compares the fragmentless target with the serialized script URL prefix.
        if (typeof requested !== "string" || !URL.canParse(requested))
          throw new TypeError("URL must be within Service Worker scope");
        const target = new URL(requested);
        target.hash = "";
        if (!isAppUrl(target.href) || !target.href.startsWith(url))
          throw new TypeError("URL must be within Service Worker scope");
        return script.readAll(target.href, name, signal);
      }),
    );
    worker.ipc.handle(channels.storeSet, (_event, input: unknown) =>
      invokeCookieStore(current() ? worker.scriptURL : undefined, (scriptUrl, signal) =>
        script.writeStructured(scriptUrl, input, signal),
      ),
    );
    worker.ipc.handle(channels.acquire, (_event, scope: unknown, operation: unknown) => {
      if (!current() || scope !== worker.scope) throw new Error("Invalid worker scope");
      return manager.acquire(worker.scope, validateOperation(worker.scope, operation), versionId);
    });
    worker.ipc.handle(channels.complete, (_event, id: unknown, success: unknown) => {
      if (!current() || typeof id !== "string" || typeof success !== "boolean") throw new Error("Invalid completion");
      return manager.complete(id, success, versionId);
    });
    for (const method of ["started", "ack", "nack"] as const) {
      worker.ipc.on(channels[method], (_event, eventId: unknown) => {
        if (current() && typeof eventId === "string") manager[method]({ versionId, eventId });
      });
    }
  }

  serviceWorkers.on("running-status-changed", ({ versionId, runningStatus }) => {
    if (runningStatus === "starting" || runningStatus === "running") attach(versionId);
    if (runningStatus === "stopped") {
      running.delete(versionId);
      manager.workerDestroyed(versionId);
    }
  });
  for (const id of Object.keys(serviceWorkers.getAllRunning())) attach(Number(id));

  // WebFrameMain has no destruction event. Watch only documents with outstanding
  // operations, including a request still queued behind another owner.
  const watched = new Map<string, () => boolean>();
  let sweep: ReturnType<typeof setInterval> | undefined;
  function watchFrames() {
    for (const [id, alive] of watched) {
      if (!alive()) manager.ownerDestroyed(id);
      if (!manager.hasOwner(id)) watched.delete(id);
    }
    if (!watched.size) {
      clearInterval(sweep);
      sweep = undefined;
    }
  }
  function frameOwner(event: IpcMainInvokeEvent, documentId: unknown) {
    const frame = event.senderFrame;
    if (
      !frame ||
      frame.isDestroyed() ||
      frame.origin !== script.origin ||
      !ownsSender(event.sender) ||
      typeof documentId !== "string"
    )
      throw new Error("Invalid subscription sender");
    const token = frame.frameToken;
    return { id: token + ":" + documentId, alive: () => !frame.isDestroyed() && frame.frameToken === token };
  }
  ipcMain.handle(channels.acquire, (event, documentId: unknown, scope: unknown, input: unknown) => {
    const owner = frameOwner(event, documentId);
    if (typeof scope !== "string" || !isAppUrl(scope)) throw new Error("Invalid registration scope");
    const operation = validateOperation(scope, input);
    watched.set(owner.id, owner.alive);
    sweep ??= setInterval(watchFrames, 100);
    return manager.acquire(scope, operation, owner.id);
  });
  ipcMain.handle(channels.complete, (event, documentId: unknown, id: unknown, success: unknown) => {
    const owner = frameOwner(event, documentId);
    if (typeof id !== "string" || typeof success !== "boolean") throw new Error("Invalid completion");
    return manager.complete(id, success, owner.id);
  });
  changes.on("changed", (_event, cookie, cause) => {
    const items = publicChange(script, cookie, cause);
    if (items) manager.onChange({ ...items, time: now() });
  });
  return {
    quitAll() {
      clearInterval(sweep);
      watched.clear();
      return manager.quitAll();
    },
  };
}
