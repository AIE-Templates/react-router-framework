import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { channelFromWebSocket } from "@repo/channel";
import { WebSocket } from "ws";

import type { RunConfig } from "../config.ts";
import { type Endpoint, fromChannel, rawFromWs } from "../endpoint.ts";
import { parseJson } from "../guards.ts";
import { type LinkHandle, wsChannelOptions, wsProtocols } from "./link.ts";

/**
 * A `ws` client on this process and a `ws` server in a separate Node process on the loopback
 * interface, permessage-deflate off on both sides: the local baseline for browser ↔ BFF and
 * utility ↔ gateway. Client frames are masked, as any WebSocket client's are.
 */
export async function startWsServer(
  config: RunConfig,
): Promise<{ url: string; peerClose: Promise<unknown>; stop(): Promise<void> }> {
  const child = spawn(
    process.execPath,
    // The run's own flags (the `@repo/source` condition among them), so the peer loads the same package code.
    [...process.execArgv, new URL("./peer-ws-server.ts", import.meta.url).pathname, JSON.stringify(config)],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  let reportClose: ((report: unknown) => void) | undefined;
  const peerClose = new Promise<unknown>((resolve) => (reportClose = resolve));
  const url = await new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (line.startsWith("LISTENING ")) resolve(line.slice("LISTENING ".length).trim());
      else if (line.startsWith("PEERCLOSE ")) reportClose?.(parseJson(line.slice("PEERCLOSE ".length)));
    });
    child.once("exit", (code) => reject(new Error(`ws server exited with ${code} before listening`)));
  });
  return {
    url,
    peerClose,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

export function connectWs(url: string, config: RunConfig): { socket: WebSocket; endpoint: Endpoint } {
  const socket = new WebSocket(url, wsProtocols(config), { perMessageDeflate: false });
  const endpoint =
    config.variant === "raw" ? rawFromWs(socket) : fromChannel(channelFromWebSocket(socket, wsChannelOptions(config)));
  return { socket, endpoint };
}

export async function setupWs(config: RunConfig): Promise<LinkHandle> {
  const server = await startWsServer(config);
  const { endpoint } = connectWs(server.url, config);
  await endpoint.ready();
  return {
    endpoint,
    peerClose: server.peerClose,
    async teardown() {
      endpoint.close();
      await server.stop();
    },
  };
}
