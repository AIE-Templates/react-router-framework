import type { MessagePort as NodeMessagePort } from "node:worker_threads";

import {
  channelFromPort,
  CREDIT_SUBPROTOCOL,
  fromNodePort as channelPort,
  type PortChannelOptions,
  type WebSocketChannelOptions,
} from "@repo/channel";

import type { PeerCloseReport } from "../backlog.ts";
import type { RunConfig } from "../config.ts";
import { type Endpoint, fromChannel, rawFromNodePort } from "../endpoint.ts";
import { servePeer } from "../fetch.ts";
import { runPeer } from "../peer.ts";
import type { StatsTree } from "../stats.ts";

/** What a link gives the sender: a stream endpoint, or a port for port-fetch, and a way to tear down. */
export interface LinkHandle {
  endpoint?: Endpoint;
  port?: NodeMessagePort;
  /** Counters of what the link itself runs in this process besides the endpoint (the relay). */
  stats?(): Record<string, StatsTree | undefined>;
  /**
   * The peer's report of its connection closing, over a side channel (a worker message, the ws
   * server's stdout, a callback): unchecked JSON, settled once the peer reports.
   */
  peerClose?: Promise<unknown>;
  teardown(): Promise<void>;
}

/** Options for a port channel of this run: the harness's window, then `--options` channel keys. */
export function portChannelOptions(config: RunConfig): PortChannelOptions {
  return { windowBytes: config.windowBytes, ...config.options.channel };
}

/**
 * The WebSocket subprotocols the client offers: the credit one when the package variant runs with
 * `options.channel.credit`, since the mode is negotiated in the handshake, not by the option alone.
 */
export function wsProtocols(config: RunConfig): string[] {
  return config.variant === "package" && config.options.channel?.credit ? [CREDIT_SUBPROTOCOL] : [];
}

/**
 * Options for a WebSocket channel of this run: low water at half the window (in credit mode the
 * package derives it from the peer's window), the send callback on, then `--options`. Every caller
 * wraps a `ws` package socket, whose `send(data, cb)` calls back once the frame is written, so
 * `sendWithCallback: true` is safe here and keeps the mode earlier results were measured with (the
 * package default became `false`). Never pass it for Node's built-in WebSocket: it ignores the
 * callback and drain would wait forever.
 */
export function wsChannelOptions(config: RunConfig): WebSocketChannelOptions {
  // In credit mode the low water follows the peer's credit window unless set (half of it), so the
  // harness leaves it to the package; `--options` can still pass `lowWaterBytes`.
  const lowWater = config.options.channel?.credit ? {} : { lowWaterBytes: Math.floor(config.windowBytes / 2) };
  return { ...lowWater, sendWithCallback: true, ...config.options.channel };
}

/** The sender-side endpoint over a Node message port, raw or wrapped in a Channel. */
export function senderEndpoint(port: NodeMessagePort, config: RunConfig): Endpoint {
  return config.variant === "raw"
    ? rawFromNodePort(port)
    : fromChannel(channelFromPort(channelPort(port), portChannelOptions(config)));
}

/** The peer side over a Node message port: consumer for stream cases, server for fetch cases. */
export function startPortPeer(
  port: NodeMessagePort,
  config: RunConfig,
  report?: (report: PeerCloseReport) => void,
): { stop(): void } {
  if (config.caseSpec.fetch) {
    const server = servePeer(port, config);
    return { stop: () => server.close() };
  }
  const endpoint =
    config.variant === "raw"
      ? rawFromNodePort(port)
      : fromChannel(channelFromPort(channelPort(port), portChannelOptions(config)));
  return runPeer(endpoint, config, report);
}
