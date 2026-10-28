import type { MessagePort as NodeMessagePort } from "node:worker_threads";

import {
  type Channel,
  type ChannelCloseInfo,
  type ChannelState,
  type ChannelStats,
  CLOSE_CODES,
  DRAINED,
  emptyStats,
  frameBytes,
  Handlers,
  isCloseCode,
  type MessageHandler,
  normalizeCloseReason,
} from "./channel.ts";
import { type FlowControlOptions, SendWindow } from "./flow-control.ts";
import { checkInteger, checkMs, snapshot } from "./options.ts";

/**
 * The port frame protocol's major version, carried in the `open` frame. A peer announcing another
 * version is closed with `CLOSE_CODES.protocolError`; an `open` without `v` is version 1.
 */
export const PROTOCOL_VERSION = 1;

/**
 * The frames a port channel exchanges. Both sides send `open` first (with the protocol version and
 * optional capabilities) and are open once they have the other's. `data` carries one message with
 * its byte count; the receiver answers `ack` once its handlers took it (see flow-control.ts), one
 * `ack` possibly covering several frames (`ackCoalesce`). `close` ends the channel from either side.
 * `ping`/`pong` keep an idle timeout from firing. Binary payloads are structured-cloned by the port.
 *
 * Every received frame is validated (`isPortFrame`): a malformed known frame, `data` or `ack` before
 * `open`, or another protocol version closes the channel with `CLOSE_CODES.protocolError` (1002).
 * Objects with an unknown `t`, and anything that is not an object with a string `t`, are ignored.
 */
export type PortFrame =
  | { t: "open"; v?: number; caps?: Record<string, unknown> }
  | { t: "data"; d: string | Uint8Array; bytes: number }
  | { t: "ack"; bytes: number }
  | { t: "close"; code?: number; reason?: string }
  | { t: "ping" }
  | { t: "pong" };

/** The little this package needs from a port; see the adapters below. */
export interface PortLike {
  postMessage(message: PortFrame): void;
  onMessage(handler: (data: unknown) => void): () => void;
  onClose(handler: () => void): () => void;
  start?(): void;
  close(): void;
}

export interface PortChannelOptions extends FlowControlOptions {
  /**
   * Close the channel when no frame arrived for this long. Pings go out at a third of it so a live
   * peer keeps resetting the clock. Off by default.
   */
  idleTimeoutMs?: number;
  /**
   * Sent to the peer in the `open` frame and exposed there as `peerCapabilities`. A plain object
   * the port can structured-clone. Declaring a capability grants nothing; it only informs the peer.
   */
  capabilities?: Record<string, unknown>;
  /**
   * Acknowledge consumed bytes in batches instead of one `ack` per frame. Off by default (one `ack`
   * per frame, as soon as its handlers settled). When given, an `ack` goes out once `bytes`
   * consumed bytes (default 32 KiB) or `frames` consumed frames (default 32) accumulated, or
   * `delayMs` (default 1) after the first consumed byte that is not yet acknowledged, whichever
   * comes first. Only consumed bytes are ever acknowledged. The defaults are starting points for
   * the transport bench, not measured optima.
   */
  ackCoalesce?: AckCoalesceOptions;
}

export interface AckCoalesceOptions {
  bytes?: number;
  frames?: number;
  delayMs?: number;
}

/** A port channel: a `Channel` plus what the peer announced in its `open` frame. */
export interface PortChannel extends Channel {
  /** The peer's `caps` from its `open` frame, frozen; `{}` until open and when the peer sent none. */
  readonly peerCapabilities: Readonly<Record<string, unknown>>;
}

/**
 * A `Channel` over a message port: Node's `MessagePort`, the DOM's, or Electron's `MessagePortMain`.
 * Throws a `RangeError` (or `TypeError`) for nonsensical options before touching the port.
 */
export function channelFromPort(port: PortLike, options: PortChannelOptions = {}): PortChannel {
  return new PortChannelImpl(port, options);
}

/** Node `worker_threads` ports deliver the data itself to `message` listeners. */
export function fromNodePort(port: NodeMessagePort): PortLike {
  return {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a message port, not a window
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

/** What `fromEventTargetPort()` needs of a DOM `MessagePort` (also the shape Electron's renderer sees). */
export interface EventTargetPortLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "close", listener: () => void): void;
  start(): void;
  close(): void;
}

/** DOM ports wrap the data in `event.data` and need `start()`. */
export function fromEventTargetPort(port: EventTargetPortLike): PortLike {
  return {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a message port, not a window
    postMessage: (message) => port.postMessage(message),
    onMessage(handler) {
      const listener = (event: { data: unknown }) => handler(event.data);
      port.addEventListener("message", listener);
      return () => port.removeEventListener("message", listener);
    },
    onClose(handler) {
      port.addEventListener("close", handler);
      return () => port.removeEventListener("close", handler);
    },
    start: () => port.start(),
    close: () => port.close(),
  };
}

/** What `fromElectronPort()` needs of Electron's `MessagePortMain` (main and utility processes). */
export interface ElectronPortLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  off(event: "message", listener: (event: { data: unknown }) => void): unknown;
  off(event: "close", listener: () => void): unknown;
  start(): void;
  close(): void;
}

/** `MessagePortMain` wraps the data in `event.data`, uses `on`/`off` and needs `start()`. */
export function fromElectronPort(port: ElectronPortLike): PortLike {
  return {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a message port, not a window
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

const NO_CAPABILITIES: Readonly<Record<string, unknown>> = Object.freeze({});

interface AckCoalesce {
  bytes: number;
  frames: number;
  delayMs: number;
}

function resolveOptions(options: PortChannelOptions): {
  idleTimeoutMs: number | undefined;
  capabilities: Record<string, unknown> | undefined;
  ackCoalesce: AckCoalesce | undefined;
} {
  checkMs("idleTimeoutMs", options.idleTimeoutMs, { positive: true });
  const { capabilities } = options;
  if (capabilities !== undefined) {
    if (!isRecord(capabilities)) throw new TypeError("capabilities must be a plain object");
    // A port would throw DataCloneError on the `open` frame; fail here, before anything is wired.
    structuredClone(capabilities);
  }
  let ackCoalesce: AckCoalesce | undefined;
  if (options.ackCoalesce !== undefined) {
    const { bytes = 32 * 1024, frames = 32, delayMs = 1 } = options.ackCoalesce;
    checkInteger("ackCoalesce.bytes", bytes, 1);
    checkInteger("ackCoalesce.frames", frames, 1);
    checkMs("ackCoalesce.delayMs", delayMs, { positive: false });
    ackCoalesce = { bytes, frames, delayMs };
  }
  return { idleTimeoutMs: options.idleTimeoutMs, capabilities, ackCoalesce };
}

class PortChannelImpl implements PortChannel {
  state: ChannelState = "connecting";
  everOpened = false;
  peerCapabilities = NO_CAPABILITIES;
  readonly #port: PortLike;
  readonly #window: SendWindow;
  readonly #open = new Handlers<[]>();
  readonly #message = new Handlers<Parameters<MessageHandler>>();
  readonly #closed = new Handlers<[ChannelCloseInfo]>();
  readonly #unsubscribe: (() => void)[] = [];
  readonly #idleTimeoutMs: number | undefined;
  readonly #coalesce: AckCoalesce | undefined;
  readonly #stats = emptyStats();
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #ackTimer: ReturnType<typeof setTimeout> | undefined;
  #pendingAckBytes = 0;
  #pendingAckFrames = 0;

  constructor(port: PortLike, options: PortChannelOptions) {
    const { idleTimeoutMs, capabilities, ackCoalesce } = resolveOptions(options);
    this.#window = new SendWindow(options);
    this.#port = port;
    this.#idleTimeoutMs = idleTimeoutMs;
    this.#coalesce = ackCoalesce;
    this.#unsubscribe.push(
      port.onMessage((data) => this.#receive(data)),
      port.onClose(() =>
        this.#finish({ code: CLOSE_CODES.abnormal, reason: "The port closed", error: new Error("The port closed") }),
      ),
    );
    port.start?.();
    port.postMessage(
      capabilities ? { t: "open", v: PROTOCOL_VERSION, caps: capabilities } : { t: "open", v: PROTOCOL_VERSION },
    );
    this.#armIdleTimer();
  }

  get bufferedAmount(): number {
    return this.#window.outstanding;
  }

  send(data: string | Uint8Array): void {
    if (this.state === "closing" || this.state === "closed") throw new Error("The channel is closed");
    const bytes = frameBytes(data);
    this.#window.sent(bytes);
    this.#stats.framesSent++;
    this.#stats.bytesSent += bytes;
    this.#post({ t: "data", d: data, bytes });
  }

  whenDrained(): Promise<void> {
    return this.#window.whenDrained();
  }

  get [DRAINED](): boolean {
    return this.#window.drained;
  }

  onOpen(handler: () => void): () => void {
    return this.#open.add(handler);
  }

  onMessage(handler: MessageHandler): () => void {
    return this.#message.add(handler);
  }

  onClose(handler: (info: ChannelCloseInfo) => void): () => void {
    return this.#closed.add(handler);
  }

  stats(): ChannelStats {
    return snapshot({ ...this.#stats, drainWaitMs: this.#window.waitedMs });
  }

  /**
   * Closes both sides. `code` must be an integer in 1000–4999 (the range the peer accepts; a
   * `RangeError` otherwise); `reason` is cut to 123 UTF-8 bytes like a WebSocket's. Coalesced
   * acknowledgements still pending go out first.
   */
  close(code: number = CLOSE_CODES.normal, reason?: string): void {
    if (!isCloseCode(code)) throw new RangeError(`A close code must be an integer in 1000–4999, got ${String(code)}`);
    if (this.state === "closing" || this.state === "closed") return;
    const sendReason = normalizeCloseReason(reason);
    this.#flushAcks();
    this.state = "closing";
    this.#post(sendReason === undefined ? { t: "close", code } : { t: "close", code, reason: sendReason });
    this.#finish({ code, reason: sendReason });
  }

  #receive(frame: unknown): void {
    try {
      if (!isPortFrame(frame)) return;
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      this.#protocolError(error.message);
      return;
    }
    this.#armIdleTimer();
    switch (frame.t) {
      case "open": {
        if (this.state !== "connecting") return;
        const version = frame.v ?? PROTOCOL_VERSION;
        if (version !== PROTOCOL_VERSION) {
          this.#protocolError(`the peer speaks v${version}, this side v${PROTOCOL_VERSION}`);
          return;
        }
        if (frame.caps !== undefined) this.peerCapabilities = Object.freeze({ ...frame.caps });
        this.state = "open";
        this.everOpened = true;
        this.#startPings();
        this.#open.emit();
        return;
      }
      case "data": {
        if (this.state === "connecting") {
          this.#protocolError("data before open");
          return;
        }
        const { bytes } = frame;
        this.#stats.framesReceived++;
        this.#stats.bytesReceived += bytes;
        this.#stats.heldBytes += bytes;
        this.#stats.heldFrames++;
        const results = this.#message.emit(frame.d);
        const pending = results.filter((result): result is Promise<unknown> => result instanceof Promise);
        if (pending.length) void Promise.allSettled(pending).then(() => this.#ack(bytes));
        else this.#ack(bytes);
        return;
      }
      case "ack": {
        if (this.state === "connecting") {
          this.#protocolError("ack before open");
          return;
        }
        this.#stats.acksReceived++;
        // More than is outstanding is a peer bug, not worth the connection: clamp and count it.
        if (frame.bytes > this.#window.outstanding) this.#stats.acksClamped++;
        this.#window.acked(Math.min(frame.bytes, this.#window.outstanding));
        return;
      }
      case "close":
        this.#finish({ code: frame.code, reason: normalizeCloseReason(frame.reason) });
        return;
      case "ping":
        this.#post({ t: "pong" });
        return;
      case "pong":
        return;
      default:
        return;
    }
  }

  /** The peer broke the protocol: tell it why (best effort) and close with 1002. */
  #protocolError(detail: string): void {
    if (this.state === "closed") return;
    const reason = normalizeCloseReason(`Protocol error: ${detail}`) ?? "Protocol error";
    this.#stats.protocolErrors++;
    this.state = "closing";
    this.#post({ t: "close", code: CLOSE_CODES.protocolError, reason });
    this.#finish({ code: CLOSE_CODES.protocolError, reason, error: new Error(reason) });
  }

  /** `bytes` of one frame were consumed: acknowledge them now or add them to the coalesced `ack`. */
  #ack(bytes: number): void {
    if (this.state === "closed") return;
    const coalesce = this.#coalesce;
    if (coalesce === undefined) {
      this.#postAck(bytes, 1);
      return;
    }
    this.#pendingAckBytes += bytes;
    this.#pendingAckFrames++;
    if (this.#pendingAckBytes >= coalesce.bytes || this.#pendingAckFrames >= coalesce.frames) {
      this.#flushAcks();
    } else if (this.#ackTimer === undefined) {
      this.#ackTimer = setTimeout(() => {
        this.#ackTimer = undefined;
        this.#flushAcks();
      }, coalesce.delayMs);
      unref(this.#ackTimer);
    }
  }

  #flushAcks(): void {
    clearTimeout(this.#ackTimer);
    this.#ackTimer = undefined;
    if (this.#pendingAckFrames === 0 || this.state === "closed") return;
    const bytes = this.#pendingAckBytes;
    const frames = this.#pendingAckFrames;
    this.#pendingAckBytes = 0;
    this.#pendingAckFrames = 0;
    this.#postAck(bytes, frames);
  }

  #postAck(bytes: number, frames: number): void {
    this.#stats.acksSent++;
    this.#stats.acksCoalesced += frames - 1;
    this.#stats.heldBytes -= bytes;
    this.#stats.heldFrames -= frames;
    this.#post({ t: "ack", bytes });
  }

  /** Posts a frame; a port that is already gone is settled by its close event, not here. */
  #post(frame: PortFrame): void {
    try {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a message port, not a window
      this.#port.postMessage(frame);
    } catch {
      // Closed underneath us; the port's close event finishes the channel.
    }
  }

  #startPings(): void {
    if (this.#idleTimeoutMs === undefined) return;
    this.#pingTimer = setInterval(() => this.#post({ t: "ping" }), Math.max(1, Math.floor(this.#idleTimeoutMs / 3)));
    unref(this.#pingTimer);
  }

  #armIdleTimer(): void {
    if (this.#idleTimeoutMs === undefined || this.state === "closed") return;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      const reason = `No frame for ${this.#idleTimeoutMs} ms`;
      this.state = "closing";
      this.#post({ t: "close", code: CLOSE_CODES.idleTimeout, reason });
      this.#finish({ code: CLOSE_CODES.idleTimeout, reason, error: new Error(reason) });
    }, this.#idleTimeoutMs);
    unref(this.#idleTimer);
  }

  #finish(info: ChannelCloseInfo): void {
    if (this.state === "closed") return;
    this.state = "closed";
    clearTimeout(this.#idleTimer);
    clearInterval(this.#pingTimer);
    // Acknowledgements are meaningless once closed (the peer's window is released by the close).
    clearTimeout(this.#ackTimer);
    this.#ackTimer = undefined;
    this.#pendingAckBytes = 0;
    this.#pendingAckFrames = 0;
    this.#stats.heldBytes = 0;
    this.#stats.heldFrames = 0;
    for (const off of this.#unsubscribe) off();
    this.#window.close();
    try {
      this.#port.close();
    } catch {
      // Already closed.
    }
    this.#closed.emit(info);
    this.#open.clear();
    this.#message.clear();
    this.#closed.clear();
  }
}

/** A received frame broke the schema; the message is the violation. */
class ProtocolError extends Error {}

/**
 * Validates a received value against the frame schema: `true` for a valid frame, `false` for
 * something to ignore (not an object with a string `t`, or an unknown `t`), and a `ProtocolError`
 * thrown for a malformed known frame:
 *
 * - `open`: `v` absent or a positive integer; `caps` absent or a plain object.
 * - `data`: `d` a string or a `Uint8Array`; `bytes` a non-negative safe integer equal to the
 *   payload's byte length (UTF-8 for strings).
 * - `ack`: `bytes` a non-negative safe integer (clamped to what is outstanding by the receiver).
 * - `close`: `code` absent or an integer in 1000–4999; `reason` absent or a string (cut to 123
 *   UTF-8 bytes by the receiver).
 * - `ping`, `pong`: no fields.
 */
function isPortFrame(value: unknown): value is PortFrame {
  if (typeof value !== "object" || value === null || !("t" in value)) return false;
  switch (value.t) {
    case "open": {
      const v = "v" in value ? value.v : undefined;
      const caps = "caps" in value ? value.caps : undefined;
      if (v !== undefined && !(isByteCount(v) && v >= 1)) throw new ProtocolError("open: v must be a positive integer");
      if (caps !== undefined && !isRecord(caps)) throw new ProtocolError("open: caps must be an object");
      return true;
    }
    case "data": {
      const d = "d" in value ? value.d : undefined;
      const bytes = "bytes" in value ? value.bytes : undefined;
      if (typeof d !== "string" && !(d instanceof Uint8Array)) {
        throw new ProtocolError("data: d must be a string or a Uint8Array");
      }
      if (!isByteCount(bytes)) throw new ProtocolError("data: bytes must be a non-negative integer");
      const actual = frameBytes(d);
      if (bytes !== actual) throw new ProtocolError(`data: bytes says ${bytes}, the payload has ${actual}`);
      return true;
    }
    case "ack":
      if (!("bytes" in value && isByteCount(value.bytes))) {
        throw new ProtocolError("ack: bytes must be a non-negative integer");
      }
      return true;
    case "close": {
      const code = "code" in value ? value.code : undefined;
      const reason = "reason" in value ? value.reason : undefined;
      if (code !== undefined && !isCloseCode(code))
        throw new ProtocolError("close: code must be an integer in 1000-4999");
      if (reason !== undefined && typeof reason !== "string") throw new ProtocolError("close: reason must be a string");
      return true;
    }
    case "ping":
    case "pong":
      return true;
    default:
      return false;
  }
}

function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Timers must not keep a Node process alive on their own; browsers have no `unref`. */
function unref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}
