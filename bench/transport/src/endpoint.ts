import type { MessagePort as NodeMessagePort } from "node:worker_threads";

import type { Channel } from "@repo/channel";
import type { WebSocket as WsSocket } from "ws";

import { type StatsTree, toStatsTree } from "./stats.ts";

/**
 * The little the benchmark needs from a transport end: send a frame, receive frames, close. The raw
 * implementations are the transport as is (postMessage / socket.send); the package implementation
 * wraps a `Channel`. Flow control is the caller's business: raw ends have none (the producer keeps
 * a credit window over them), channel ends expose `whenDrained()`.
 */
export interface Endpoint {
  send(data: string | Uint8Array): void;
  /** A handler may return a promise; the channel implementation holds its acknowledgement meanwhile. */
  onMessage(handler: (data: string | Uint8Array) => void | Promise<void>): () => void;
  /** The close as this end saw it: code and reason when the transport has them, `error` for a failure. */
  onClose(handler: (info: CloseInfo) => void): () => void;
  close(): void;
  ready(): Promise<void>;
  /** Package variant only: bytes sent but not yet acknowledged / flushed. */
  readonly bufferedAmount?: number;
  whenDrained?(): Promise<void>;
  /** Package variant only: the channel's `stats()` counters (undefined on a version without them). */
  stats?(): StatsTree | undefined;
}

export interface CloseInfo {
  code?: number;
  reason?: string;
  error?: string;
}

export function rawFromNodePort(port: NodeMessagePort): Endpoint {
  port.start();
  return {
    send: (data) => port.postMessage(data),
    onMessage(handler) {
      const listener = (data: unknown) => {
        if (typeof data === "string" || data instanceof Uint8Array) void handler(data);
      };
      port.on("message", listener);
      return () => port.off("message", listener);
    },
    onClose(handler) {
      const listener = () => handler({});
      port.on("close", listener);
      return () => port.off("close", listener);
    },
    close: () => port.close(),
    ready: () => Promise.resolve(),
  };
}

export function rawFromWs(socket: WsSocket): Endpoint {
  socket.binaryType = "nodebuffer";
  return {
    send: (data) => socket.send(data),
    onMessage(handler) {
      const listener = (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : data;
        void handler(isBinary ? bytes : new TextDecoder().decode(bytes));
      };
      socket.on("message", listener);
      return () => void socket.off("message", listener);
    },
    onClose(handler) {
      const listener = (code: number, reason: Buffer) => handler({ code, reason: reason.toString() });
      socket.on("close", listener);
      return () => void socket.off("close", listener);
    },
    close: () => socket.close(1000),
    ready: () =>
      socket.readyState === socket.OPEN
        ? Promise.resolve()
        : new Promise((resolve, reject) => {
            socket.once("open", () => resolve());
            socket.once("error", reject);
          }),
  };
}

export function fromChannel(channel: Channel): Endpoint {
  return {
    // A frame scheduled while the other side is tearing down is dropped, not a failure.
    send: (data) => {
      if (channel.state === "open") channel.send(data);
    },
    onMessage: (handler) => channel.onMessage(handler),
    onClose: (handler) =>
      channel.onClose((info) =>
        handler({
          code: info.code,
          reason: info.reason,
          error: errorText(info.error),
        }),
      ),
    close: () => channel.close(1000, "benchmark done"),
    ready: () =>
      channel.state === "open"
        ? Promise.resolve()
        : new Promise((resolve, reject) => {
            channel.onOpen(() => resolve());
            channel.onClose((info) =>
              reject(info.error instanceof Error ? info.error : new Error("closed before open")),
            );
          }),
    get bufferedAmount() {
      return channel.bufferedAmount;
    },
    whenDrained: () => channel.whenDrained(),
    stats: () => readStats(channel),
  };
}

/**
 * `stats()` of anything that has one. Looked up at run time rather than trusted from the type, so
 * the harness also runs against package versions that predate the counters (a baseline build).
 */
export function readStats(source: object): StatsTree | undefined {
  const stats: unknown = Reflect.get(source, "stats");
  return typeof stats === "function" ? toStatsTree(Reflect.apply(stats, source, [])) : undefined;
}

function errorText(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  return error instanceof Error ? error.message : typeof error === "string" ? error : "error";
}
