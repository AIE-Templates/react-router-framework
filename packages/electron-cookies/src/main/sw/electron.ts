import type { IpcMainInvokeEvent, ServiceWorkerMain, ServiceWorkers } from "electron";

import { invokeCookieStore, publicChange, type CookieIpcOptions } from "../../ipc.ts";
import { cookieIpcChannels, type SubscriptionOperation, type WorkerCookieItem } from "../../shared.ts";
import { CookieWorkerManager, type WakeStorage } from "./cookie-worker-manager.ts";

export interface CookieWorkerIpcOptions extends CookieIpcOptions {
  serviceWorkers: Pick<ServiceWorkers, "on" | "getAllRunning" | "getWorkerFromVersionID" | "startWorkerForScope">;
  storage: WakeStorage;
  /** Maximum lifetime of an outstanding cookie event. Defaults to five minutes. */
  taskTimeoutMs?: number;
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

// Epoch-relative sub-millisecond time survives restarts and distinguishes a write immediately after subscribe.
const now = () => performance.timeOrigin + performance.now();

export function installCookieWorkerIpc({
  serviceWorkers,
  storage,
  taskTimeoutMs,
  changes,
  jar: { script },
  ipcMain,
  prefix,
  isAppUrl,
  ownsSender,
  log,
}: CookieWorkerIpcOptions): { quitAll(): Promise<void> } {
  const channels = cookieIpcChannels(prefix);
  const running = new Map<number, ServiceWorkerMain>();
  const installed = new WeakSet<ServiceWorkerMain>();
  const manager = new CookieWorkerManager<WorkerCookieItem>({
    storage,
    taskTimeoutMs,
    logger: {
      warn({ scope, ...fields }, message) {
        const url = new URL(scope);
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
    const current = () => running.get(versionId) === worker && !worker.isDestroyed() && isAppUrl(worker.scope);
    worker.ipc.handle(channels.getAll, (_event, name: unknown) =>
      invokeCookieStore(current() ? worker.scriptURL : undefined, (url, signal) => {
        if (name !== undefined && typeof name !== "string") throw new TypeError("Invalid cookie name");
        return script.readAll(url, name, signal);
      }),
    );
    worker.ipc.handle(channels.storeSet, (_event, input: unknown) =>
      invokeCookieStore(current() ? worker.scriptURL : undefined, (_url, signal) =>
        script.writeStructured(input, signal),
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
