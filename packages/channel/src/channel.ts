/**
 * A bidirectional message channel shaped like a WebSocket, so terminal and remote-desktop libraries
 * that expect one can be given either implementation: a `MessagePort` (desktop renderer ↔ utility
 * process) or a real `WebSocket` (browser ↔ BFF, utility ↔ gateway). Strings carry control
 * messages (JSON by convention); `Uint8Array`s carry binary frames (terminal output, screen frames).
 */
export interface Channel {
  readonly state: ChannelState;
  /**
   * Whether the channel reached `open` at any point. Set synchronously when it opens, before any
   * `onOpen` handler runs, so a close inside such a handler is still a close of an open channel.
   */
  readonly everOpened: boolean;
  /**
   * Bytes sent but not yet taken by the other side (acknowledged for a port, flushed for a socket).
   * A producer that writes faster than the consumer reads must `await whenDrained()` before sending
   * more; `send()` itself never blocks and never drops.
   */
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  /** Resolves once `bufferedAmount` is at or below the low-water mark, or the channel is closed. */
  whenDrained(): Promise<void>;
  onOpen(handler: () => void): () => void;
  /**
   * Delivers each frame. A handler that returns a promise holds the acknowledgement for that frame
   * until it settles, which is how a slow consumer slows a port-based sender down (`relay()` uses it).
   */
  onMessage(handler: MessageHandler): () => void;
  onClose(handler: (info: ChannelCloseInfo) => void): () => void;
  /** Closes both sides. Codes follow WebSocket conventions: `1000` normal, `4000`–`4999` application. */
  close(code?: number, reason?: string): void;
  /**
   * A snapshot of this channel's counters. The counters are plain integer fields updated in place
   * as frames pass; the snapshot object is only built when this is called.
   */
  stats(): ChannelStats;
}

/** Counters of one channel, from its creation until now. */
export interface ChannelStats {
  framesSent: number;
  /** Strings count their UTF-8 length. */
  bytesSent: number;
  framesReceived: number;
  bytesReceived: number;
  /** `ack` frames posted (port channels, and WebSocket channels in credit mode). */
  acksSent: number;
  /** Frames whose acknowledgement rode on another frame's `ack` (`ackCoalesce`, WebSocket credit mode). */
  acksCoalesced: number;
  /** `ack` frames received (port channels, WebSocket credit mode). */
  acksReceived: number;
  /** Received `ack` frames that claimed more bytes than were outstanding and were clamped. */
  acksClamped: number;
  /** Milliseconds during which at least one `whenDrained()` was pending, rounded. */
  drainWaitMs: number;
  /**
   * Received bytes the channel still answers for: not yet acknowledged on a port or a WebSocket in
   * credit mode (handlers still running, or an `ack` waiting to be coalesced), handlers not yet
   * settled on a plain WebSocket.
   */
  heldBytes: number;
  /** The messages behind `heldBytes`: an empty message counts 0 bytes but 1 here. */
  heldFrames: number;
  /** Closes for a receiver that fell `maxPendingBytes` or `maxPendingFrames` behind (WebSocket; 0 or 1). */
  overloadCloses: number;
  /** Closes for an invalid frame or an incompatible peer (port channels, WebSocket credit mode; 0 or 1). */
  protocolErrors: number;
}

/** A zeroed `ChannelStats`, for implementations to update in place. */
export function emptyStats(): ChannelStats {
  return {
    framesSent: 0,
    bytesSent: 0,
    framesReceived: 0,
    bytesReceived: 0,
    acksSent: 0,
    acksCoalesced: 0,
    acksReceived: 0,
    acksClamped: 0,
    drainWaitMs: 0,
    heldBytes: 0,
    heldFrames: 0,
    overloadCloses: 0,
    protocolErrors: 0,
  };
}

export type ChannelState = "connecting" | "open" | "closing" | "closed";

export type MessageHandler = (data: string | Uint8Array) => void | Promise<void>;

export interface ChannelCloseInfo {
  code?: number;
  reason?: string;
  /** Set when the channel ended because of a failure (transport error, idle timeout), not a `close()`. */
  error?: unknown;
}

/** Close codes this package emits besides those an application passes to `close()`. */
export const CLOSE_CODES = {
  normal: 1000,
  /** The peer sent an invalid frame or speaks another protocol version (port channels, WebSocket credit mode). Sent on a socket as 4002. */
  protocolError: 1002,
  /** The transport went away without a close frame (a port closed, a socket dropped). */
  abnormal: 1006,
  /** The far side hit an error. */
  internalError: 1011,
  /** No frame arrived within the idle timeout. */
  idleTimeout: 4000,
  /** The receiver could not keep up and the transport cannot be paused (see the README's overload policy). */
  overloaded: 4008,
  /** A received message was larger than `maxMessageBytes`; sent on the wire as 4009 (see `sendableCloseCode`). */
  messageTooBig: 1009,
} as const;

/**
 * Package-internal (not exported from the index): a channel implementation of this package answers
 * `channel[DRAINED]` with whether `whenDrained()` would resolve right now, so `relay()` can keep
 * forwarding without allocating a promise per frame. A channel without it is asked through
 * `whenDrained()` instead.
 */
export const DRAINED: unique symbol = Symbol("drained");

/** `channel[DRAINED]`, or `undefined` for a channel that does not answer it. */
export function drainedNow(channel: Channel): boolean | undefined {
  const drained: unknown = Reflect.get(channel, DRAINED);
  return typeof drained === "boolean" ? drained : undefined;
}

/** A code `close()` accepts on every channel: an integer in 1000–4999. */
export function isCloseCode(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1000 && value <= 4999;
}

/** The longest close reason a WebSocket accepts, in UTF-8 bytes. */
export const MAX_CLOSE_REASON_BYTES = 123;

/**
 * `reason` cut to `MAX_CLOSE_REASON_BYTES` of UTF-8 on a character boundary, as a WebSocket requires.
 * Port channels apply it to the reasons they send and receive, so reasons cross a relay unchanged.
 */
export function normalizeCloseReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const bytes = encoder.encode(reason);
  if (bytes.byteLength <= MAX_CLOSE_REASON_BYTES) return reason;
  let end = MAX_CLOSE_REASON_BYTES;
  // Step back to the start of the UTF-8 sequence that straddles the cut.
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end--;
  return decoder.decode(bytes.subarray(0, end));
}

/** Resolves once `channel` is open; rejects if it closes first. */
export function opened(channel: Channel): Promise<void> {
  if (channel.state === "open") return Promise.resolve();
  if (channel.state === "closing" || channel.state === "closed") {
    return Promise.reject(new Error("The channel is closed"));
  }
  return new Promise((resolve, reject) => {
    const offOpen = channel.onOpen(() => {
      offClose();
      resolve();
    });
    const offClose = channel.onClose((info) => {
      offOpen();
      reject(info.error instanceof Error ? info.error : new Error(`The channel closed (${info.code ?? "?"})`));
    });
  });
}

/** How many bytes a frame counts for in flow control: UTF-8 length for strings. */
export function frameBytes(data: string | Uint8Array): number {
  return typeof data === "string" ? utf8Length(data) : data.byteLength;
}

/**
 * The UTF-8 length of `text` as `TextEncoder` would produce it (a lone surrogate becomes U+FFFD,
 * 3 bytes). Short strings, the common control message, are counted without allocating.
 */
export function utf8Length(text: string): number {
  if (text.length > 1024) return encoder.encode(text).byteLength;
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) length += 1;
    else if (unit < 0x800) length += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      length += 4;
      i++;
    } else length += 3;
  }
  return length;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A small typed event list: subscribe, unsubscribe, emit. Handlers added during emit run next time.
 */
export class Handlers<T extends unknown[]> {
  #handlers = new Set<(...args: T) => unknown>();

  add(handler: (...args: T) => unknown): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  emit(...args: T): unknown[] {
    return [...this.#handlers].map((handler) => handler(...args));
  }

  clear(): void {
    this.#handlers.clear();
  }
}
