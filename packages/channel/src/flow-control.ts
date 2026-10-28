import { checkInteger, now } from "./options.ts";

/**
 * Flow control for transports without backpressure of their own (`postMessage`): the sender counts
 * the bytes of every data frame it posts, the receiver acknowledges the bytes of every frame once
 * its handlers have taken it, and the sender reports the difference as `bufferedAmount`. A producer
 * keeps `bufferedAmount` under `windowBytes` by awaiting `whenDrained()`, which resolves once the
 * outstanding bytes fall to `lowWaterBytes` (half the window unless given).
 *
 * A plain WebSocket has the socket's own `bufferedAmount` (how much is still unsent) and TCP
 * backpressure underneath; its credit mode (`CREDIT_SUBPROTOCOL`) reuses `SendWindow` for consumer
 * credit end to end.
 */
export interface FlowControlOptions {
  /** Unacknowledged bytes a producer should keep under. Defaults to 1 MiB. */
  windowBytes?: number;
  /** `whenDrained()` resolves at or below this. Defaults to half the window. */
  lowWaterBytes?: number;
}

export const DEFAULT_WINDOW_BYTES = 1024 * 1024;

/** The sender's half: outstanding bytes and the drain promise. */
export class SendWindow {
  readonly windowBytes: number;
  readonly lowWaterBytes: number;
  #outstanding = 0;
  #waiters: (() => void)[] = [];
  #closed = false;
  #waitStart = 0;
  #waitedMs = 0;

  /** Throws a `RangeError` for a window below 1 byte or a low-water mark outside `0..windowBytes`. */
  constructor({ windowBytes = DEFAULT_WINDOW_BYTES, lowWaterBytes }: FlowControlOptions = {}) {
    checkInteger("windowBytes", windowBytes, 1);
    checkInteger("lowWaterBytes", lowWaterBytes, 0);
    if (lowWaterBytes !== undefined && lowWaterBytes > windowBytes) {
      throw new RangeError(`lowWaterBytes (${lowWaterBytes}) must not exceed windowBytes (${windowBytes})`);
    }
    this.windowBytes = windowBytes;
    this.lowWaterBytes = lowWaterBytes ?? Math.floor(windowBytes / 2);
  }

  /** Milliseconds during which at least one `whenDrained()` was pending. */
  get waitedMs(): number {
    return this.#waitedMs + (this.#waiters.length > 0 ? now() - this.#waitStart : 0);
  }

  get outstanding(): number {
    return this.#outstanding;
  }

  /** Whether the producer should wait before sending more. */
  get full(): boolean {
    return this.#outstanding >= this.windowBytes;
  }

  sent(bytes: number): void {
    this.#outstanding += bytes;
  }

  acked(bytes: number): void {
    this.#outstanding = Math.max(0, this.#outstanding - bytes);
    if (this.#outstanding <= this.lowWaterBytes) this.#wake();
  }

  /** What `whenDrained()` would resolve at once for: closed, or at or below the low-water mark. */
  get drained(): boolean {
    return this.#closed || this.#outstanding <= this.lowWaterBytes;
  }

  whenDrained(): Promise<void> {
    if (this.drained) return Promise.resolve();
    if (this.#waiters.length === 0) this.#waitStart = now();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** Nothing more will be acknowledged: release every waiter. */
  close(): void {
    this.#closed = true;
    this.#outstanding = 0;
    this.#wake();
  }

  #wake(): void {
    if (this.#waiters.length === 0) return;
    this.#waitedMs += now() - this.#waitStart;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
  }
}
