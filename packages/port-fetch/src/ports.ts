import type { MessagePort } from "node:worker_threads";

import type { PortMessage } from "./protocol.ts";

/**
 * The little this package needs from a message port, so one adapter per runtime suffices. Node's
 * `MessagePort` (`node:worker_threads`) is below; Electron's `MessagePortMain` differs only in that
 * its `message` event wraps the data (`event.data`) and that it must be started explicitly.
 */
export interface Port {
  postMessage(message: PortMessage): void;
  /** Delivers every message; returns a function that removes the handler. */
  onMessage(handler: (message: unknown) => void): () => void;
  /** Fires once the port is closed, from either side; returns a function that removes the handler. */
  onClose(handler: () => void): () => void;
  /** Starts delivering queued messages, where the runtime needs it. */
  start?(): void;
  close(): void;
}

/** A `Port` over Node's `MessagePort`, which delivers the data itself to `message` listeners. */
export function fromNodePort(port: MessagePort): Port {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage(handler) {
      port.on("message", handler);
      return () => port.off("message", handler);
    },
    onClose(handler) {
      port.on("close", handler);
      return () => port.off("close", handler);
    },
    start: () => port.start(),
    close: () => port.close(),
  };
}

/**
 * What this package uses of Electron's `MessagePortMain` (main and utility processes), typed
 * structurally so the package has no dependency on Electron: `message` events carry the data in
 * `event.data`, listeners are added with `on()` and removed with `off()`, and delivery only starts
 * after `start()`.
 */
export interface ElectronPortLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  off(event: "message", listener: (event: { data: unknown }) => void): unknown;
  off(event: "close", listener: () => void): unknown;
  start(): void;
  close(): void;
}

/**
 * A `Port` over Electron's `MessagePortMain`. Remember that a port sent to a utility process with
 * `child.postMessage(message, [port])` only arrives if the child has already emitted `spawn`.
 */
export function fromElectronPort(port: ElectronPortLike): Port {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage(handler) {
      const listener = (event: { data: unknown }) => handler(event.data);
      port.on("message", listener);
      return () => port.off("message", listener);
    },
    onClose(handler) {
      port.on("close", handler);
      return () => port.off("close", handler);
    },
    start: () => port.start(),
    close: () => port.close(),
  };
}
