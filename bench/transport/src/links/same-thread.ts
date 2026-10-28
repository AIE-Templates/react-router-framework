import { MessageChannel } from "node:worker_threads";

import type { RunConfig } from "../config.ts";
import { type LinkHandle, senderEndpoint, startPortPeer } from "./link.ts";

/**
 * Both ends in one thread: the cheapest possible port, a reference for fixed costs only. Sender and
 * consumer share the event loop, so nothing here says what a cross-thread or cross-process link costs.
 */
export function setupSameThread(config: RunConfig): Promise<LinkHandle> {
  const { port1, port2 } = new MessageChannel();
  let report: ((report: unknown) => void) | undefined;
  const peerClose = new Promise<unknown>((resolve) => (report = resolve));
  const peer = startPortPeer(port2, config, (r) => report?.(r));
  return Promise.resolve({
    peerClose,
    endpoint: config.caseSpec.fetch ? undefined : senderEndpoint(port1, config),
    port: config.caseSpec.fetch ? port1 : undefined,
    teardown() {
      peer.stop();
      port1.close();
      port2.close();
      return Promise.resolve();
    },
  });
}
