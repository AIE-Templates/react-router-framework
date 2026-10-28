import { MessageChannel, Worker } from "node:worker_threads";

import type { RunConfig } from "../config.ts";
import { isRecord } from "../guards.ts";
import { type LinkHandle, senderEndpoint } from "./link.ts";

/**
 * Sender on the main thread, peer in a `worker_threads` Worker that receives its port by transfer:
 * a real cross-thread port with structured clone between isolates, the native comparison point
 * for Electron's main ↔ utility and renderer ↔ utility ports (which are cross-process on top).
 */
export async function setupWorker(config: RunConfig): Promise<LinkHandle> {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL("./peer-worker.ts", import.meta.url), {
    workerData: { config, port: port2 },
    transferList: [port2],
  });
  const peerClose = new Promise<unknown>((resolve) => {
    worker.on("message", (message: unknown) => {
      if (isRecord(message) && "peerClose" in message) resolve(message.peerClose);
    });
  });
  await new Promise<void>((resolve, reject) => {
    worker.once("online", resolve);
    worker.once("error", reject);
  });
  return {
    peerClose,
    endpoint: config.caseSpec.fetch ? undefined : senderEndpoint(port1, config),
    port: config.caseSpec.fetch ? port1 : undefined,
    async teardown() {
      port1.close();
      await worker.terminate();
    },
  };
}
