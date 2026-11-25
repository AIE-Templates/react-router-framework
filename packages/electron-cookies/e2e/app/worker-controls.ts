import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ipcMain, type Session } from "electron";

import type { CookieWorkerIpcOptions, WakeRecord, WakeStorage } from "../../src/main.ts";
import { deferred } from "../../src/main/sw/deferred.ts";
import { cookieIpcChannels } from "../../src/shared.ts";

export type WorkerGate = "index-written" | "native-complete" | "wake";

export function workerControls(session: Session, profile: string) {
  const { serviceWorkers } = session;
  const channels = cookieIpcChannels("fixture");
  const index = join(profile, "wake-index.json");
  let gate: { point: WorkerGate; reached: boolean; wait: Promise<void>; release(): void } | undefined;
  function cross(point: WorkerGate) {
    if (gate?.point === point) {
      gate.reached = true;
      return gate.wait;
    }
    return undefined;
  }
  const storage: WakeStorage = {
    read: () => (existsSync(index) ? JSON.parse(readFileSync(index, "utf8")) : []),
    async write(records: readonly WakeRecord[]) {
      await writeFile(index + ".new", JSON.stringify(records));
      await rename(index + ".new", index);
      await cross("index-written");
    },
  };

  // Fence cookie writes on main's real change notification before unregistering or subscribing.
  const observedWrites: string[] = [];
  session.cookies.on("changed", (_event, cookie, cause) => {
    if (gate?.point === "wake" && cause === "inserted") observedWrites.push(cookie.value);
  });

  const wakeAttempts: string[] = [];
  let wakeCount = 0;
  function running() {
    // Electron 45 supplies the version ID as the record key.
    return Object.entries(serviceWorkers.getAllRunning()).map(([id, { scope, scriptUrl }]) => ({
      versionId: Number(id),
      scope,
      scriptUrl,
    }));
  }
  const options: Pick<CookieWorkerIpcOptions, "storage" | "serviceWorkers" | "ipcMain" | "taskTimeoutMs"> = {
    storage,
    taskTimeoutMs: process.env.COOKIE_FIXTURE_TASK_TIMEOUT_MS
      ? Number(process.env.COOKIE_FIXTURE_TASK_TIMEOUT_MS)
      : undefined,
    ipcMain: {
      on: ipcMain.on.bind(ipcMain),
      handle(channel, listener) {
        ipcMain.handle(channel, async (event, ...args) => {
          // A successful native window subscribe has returned, but main has not received completion.
          if (channel === channels.complete && args[2] === true) await cross("native-complete");
          return listener(event, ...args);
        });
      },
    },
    serviceWorkers: {
      on: serviceWorkers.on.bind(serviceWorkers),
      getAllRunning: () => serviceWorkers.getAllRunning(),
      getWorkerFromVersionID: (id) => serviceWorkers.getWorkerFromVersionID(id),
      async startWorkerForScope(scope) {
        wakeAttempts.push(scope);
        await cross("wake");
        const worker = await serviceWorkers.startWorkerForScope(scope);
        wakeCount++;
        return worker;
      },
    },
  };
  return {
    options,
    controls: {
      index: () => storage.read(),
      deliveryState(scope: string) {
        const info = running().find((entry) => entry.scope === scope);
        const worker = info && serviceWorkers.getWorkerFromVersionID(info.versionId);
        if (!worker) return { wakes: wakeCount, pending: null };
        // Electron 45 exposes Chromium's external request count for its own service worker tests.
        // Reading it neither wakes the worker nor extends the lifetime under observation.
        const count: unknown = Reflect.get(worker, "_countExternalRequests");
        if (typeof count !== "function") throw new Error("Missing Electron ServiceWorkerMain._countExternalRequests");
        const pending: number = Reflect.apply(count, worker, []);
        return { wakes: wakeCount, pending };
      },
      wakeAttempts,
      observedWrites,
      running,
      arm(point: WorkerGate) {
        if (gate) throw new Error("Worker gate already armed");
        const latch = deferred<void>();
        gate = { point, reached: false, wait: latch.promise, release: latch.resolve };
      },
      reached: () => gate?.reached === true,
      release() {
        gate?.release();
        gate = undefined;
      },
      async probe(scope: string) {
        const worker = await serviceWorkers.startWorkerForScope(scope);
        const result = new Promise<unknown>((resolve) => {
          worker.ipc.once("fixture:worker-probe-result", (_event, data: unknown) => resolve(data));
        });
        worker.send("fixture:probe-worker");
        return result;
      },
    },
  };
}
