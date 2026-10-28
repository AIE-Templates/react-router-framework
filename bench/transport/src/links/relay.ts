import { MessageChannel } from "node:worker_threads";

import { channelFromPort, channelFromWebSocket, fromNodePort, opened, relay } from "@repo/channel";
import { WebSocket } from "ws";

import type { RunConfig } from "../config.ts";
import { fromChannel, readStats } from "../endpoint.ts";
import { type LinkHandle, portChannelOptions, wsChannelOptions, wsProtocols } from "./link.ts";
import { startWsServer } from "./ws.ts";

/**
 * Sender → port channel → `relay()` in this process → ws client → ws server process (peer):
 * the utility's job between the renderer's port and the gateway's socket, two hops with
 * backpressure across both. Package variant only.
 */
export async function setupRelay(config: RunConfig): Promise<LinkHandle> {
  const server = await startWsServer(config);
  const { port1, port2 } = new MessageChannel();
  const sender = channelFromPort(fromNodePort(port1), portChannelOptions(config));
  const inner = channelFromPort(fromNodePort(port2), portChannelOptions(config));
  const socket = new WebSocket(server.url, wsProtocols(config), { perMessageDeflate: false });
  const outer = channelFromWebSocket(socket, wsChannelOptions(config));
  const link = relay(inner, outer, config.options.relay);
  const endpoint = fromChannel(sender);
  // Start sending only once the socket hop is open too: frames the relay holds for a connecting
  // destination count against its maxPendingBytes, and one 1 MiB frame would already exceed it.
  await Promise.all([endpoint.ready(), opened(outer)]);
  return {
    endpoint,
    peerClose: server.peerClose,
    stats: () => ({ relay: readStats(link), relayInner: readStats(inner), relayOuter: readStats(outer) }),
    async teardown() {
      endpoint.close();
      link.close();
      await link.done;
      port1.close();
      port2.close();
      await server.stop();
    },
  };
}
