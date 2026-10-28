import { CREDIT_SUBPROTOCOL, channelFromWebSocket } from "@repo/channel";
import { WebSocketServer } from "ws";
import type { WebSocket as WsSocket } from "ws";

import { fromChannel, rawFromWs } from "../endpoint.ts";
import { expect, isRunConfig, parseJson } from "../guards.ts";
import { sourcePackages } from "../packages.ts";
import { runPeer } from "../peer.ts";
import { wsChannelOptions } from "./link.ts";

sourcePackages();

// The server process of the `ws` and `relay` links: one connection, the peer logic on it.
const config = expect(parseJson(process.argv[2] ?? "{}"), isRunConfig, "run config");
const server = new WebSocketServer({
  host: "127.0.0.1",
  port: 0,
  perMessageDeflate: false,
  maxPayload: 64 * 1024 * 1024,
  // Select the credit subprotocol only when offered; never the first offer by default.
  handleProtocols: (protocols) => (protocols.has(CREDIT_SUBPROTOCOL) ? CREDIT_SUBPROTOCOL : false),
});
server.on("connection", (socket) => {
  const channelSocket = config.wsReceiver === "standard" ? withoutPause(socket) : socket;
  const endpoint =
    config.variant === "raw"
      ? rawFromWs(socket)
      : fromChannel(channelFromWebSocket(channelSocket, wsChannelOptions(config)));
  const peer = runPeer(endpoint, config, (report) => process.stdout.write(`PEERCLOSE ${JSON.stringify(report)}\n`));
  socket.once("close", () => peer.stop());
});
server.once("listening", () => {
  const address = server.address();
  if (typeof address === "object" && address) process.stdout.write(`LISTENING ws://127.0.0.1:${address.port}\n`);
});
/**
 * The `ws` socket as the channel would see a standard `WebSocket` (a browser's): without `pause()`
 * and `resume()`, so it keeps reading whatever the consumer does and the channel's overload rule
 * closes it with `4008` instead of pausing it. Everything else is the socket itself.
 */
function withoutPause(socket: WsSocket): WsSocket {
  return new Proxy(socket, {
    get(target, key) {
      if (key === "pause" || key === "resume") return undefined;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set: (target, key, value) => Reflect.set(target, key, value, target),
  });
}

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});
