import type { AckCoalesceOptions } from "./options.ts";
import type { PortMessage } from "./protocol.ts";
import type { Counters } from "./stats.ts";

/**
 * The sender's half of flow control for one body: `reserve()` waits while `windowBytes` are
 * unacknowledged, `ack()` frees them, `release()` unblocks everyone when the body is abandoned.
 */
export class FlowWindow {
  readonly windowBytes: number;
  readonly #counters: Counters;
  #unacked = 0;
  #waiters: (() => void)[] = [];

  constructor(windowBytes: number, counters: Counters) {
    this.windowBytes = windowBytes;
    this.#counters = counters;
  }

  async reserve(bytes: number): Promise<void> {
    if (this.#unacked + bytes > this.windowBytes && this.#unacked > 0) {
      const start = performance.now();
      while (this.#unacked + bytes > this.windowBytes && this.#unacked > 0) {
        await new Promise<void>((resolve) => this.#waiters.push(resolve));
      }
      this.#counters.creditWaitMs += performance.now() - start;
    }
    this.#unacked += bytes;
  }

  /**
   * Frees `bytes` of credit. An ack for more than is outstanding (a peer acknowledging bytes it was
   * never sent) is clamped to what is outstanding and counted; it never adds credit.
   */
  ack(bytes: number): void {
    if (bytes > this.#unacked) {
      this.#counters.acksClamped++;
      this.#unacked = 0;
    } else {
      this.#unacked -= bytes;
    }
    this.#wake();
  }

  release(): void {
    this.#unacked = 0;
    this.#wake();
  }

  #wake(): void {
    if (this.#waiters.length === 0) return;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
  }
}

/**
 * Sends `body` as chunk messages, each at most `chunkBytes` long and owning its bytes (a view of a
 * larger buffer would make the port clone the whole buffer per chunk), waiting for acks as the
 * window fills. `done` resolves with `true` once the end message was sent and `false` once
 * `cancel()` stopped it; it rejects when the source fails or posting throws. `cancel()` works at
 * any moment, a pending `read()` included: it cancels the source, releases the window and the
 * reader's lock.
 */
export class BodyPump {
  readonly done: Promise<boolean>;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #window: FlowWindow;
  readonly #chunkBytes: number;
  #cancelled = false;

  constructor(
    body: ReadableStream<Uint8Array>,
    send: (chunk: Uint8Array) => PortMessage,
    end: () => PortMessage,
    post: (message: PortMessage) => void,
    window: FlowWindow,
    chunkBytes: number = window.windowBytes,
  ) {
    this.#reader = body.getReader();
    this.#window = window;
    this.#chunkBytes = Math.min(chunkBytes, window.windowBytes);
    this.done = this.#run(send, end, post);
  }

  cancel(reason?: unknown): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#window.release();
    // A pending read settles with `done` once the reader is cancelled; release the lock after.
    void this.#reader
      .cancel(reason)
      .catch(() => {})
      .finally(() => this.#releaseLock());
  }

  async #run(
    send: (chunk: Uint8Array) => PortMessage,
    end: () => PortMessage,
    post: (message: PortMessage) => void,
  ): Promise<boolean> {
    try {
      for (;;) {
        const { done, value } = await this.#reader.read();
        if (this.#cancelled) return false;
        if (done) {
          post(end());
          return true;
        }
        for (let offset = 0; offset < value.byteLength; offset += this.#chunkBytes) {
          const length = Math.min(this.#chunkBytes, value.byteLength - offset);
          const chunk = new Uint8Array(length);
          chunk.set(value.subarray(offset, offset + length));
          await this.#window.reserve(length);
          if (this.#cancelled) return false;
          post(send(chunk));
        }
      }
    } finally {
      if (!this.#cancelled) this.#releaseLock();
    }
  }

  #releaseLock(): void {
    try {
      this.#reader.releaseLock();
    } catch {
      // Already released, or the stream is gone.
    }
  }
}

/**
 * The unread bytes one ended body still holds: `ReceiveBudget.ended()` hands it out, and the body's
 * reads and drops count it down. It is also the held value (and unregister token) of the budget's
 * `FinalizationRegistry` entry for that body, so it must never reference the body.
 */
export interface EndedShare {
  bytes: number;
}

/**
 * The receiving side's budget for one connection: body bytes received but not yet consumed, across
 * every request. While the total exceeds `maxBytes`, a receiver that still has a backlog of its own
 * holds back its acks, so its sender stops once its window is used up; the held acks go out when
 * the total is back within budget or the receiver's own backlog is gone. Receivers that keep up
 * (nothing queued) keep acking, so one body nobody reads cannot stall every other request.
 *
 * `endedBytes` is the part of the total that belongs to bodies whose sender already sent its end:
 * no ack can hold those back, so the client refuses new requests while it exceeds `maxBytes`.
 * Reads and cancels give them back at once. A body dropped unread gives them back when it is
 * garbage-collected: each ended body with bytes still queued is registered with a
 * `FinalizationRegistry` (where one exists), keyed on its `BodyReceiver`, which holds the queue and
 * which the stream's source (so any reader, stream or `Response` of it) keeps alive. Nothing else
 * depends on when, or whether, that finalizer runs.
 */
export class ReceiveBudget {
  readonly maxBytes: number;
  readonly #counters: Counters;
  readonly #held = new Set<BodyReceiver>();
  readonly #collected =
    typeof FinalizationRegistry === "function"
      ? new FinalizationRegistry<EndedShare>((share) => this.#release(share.bytes, share))
      : undefined;
  #endedBytes = 0;

  constructor(maxBytes: number, counters: Counters) {
    this.maxBytes = maxBytes;
    this.#counters = counters;
  }

  add(bytes: number): void {
    const queued = (this.#counters.queuedBytes += bytes);
    if (queued > this.#counters.peakQueuedBytes) this.#counters.peakQueuedBytes = queued;
  }

  /** Unread bytes of bodies whose sender has ended. */
  get endedBytes(): number {
    return this.#endedBytes;
  }

  /**
   * `receiver` got its end with `bytes` still queued: they now count as `endedBytes` too, until
   * they are removed through the returned share or `receiver` is garbage-collected.
   */
  ended(receiver: BodyReceiver, bytes: number): EndedShare | undefined {
    if (bytes === 0) return undefined;
    this.#endedBytes += bytes;
    const share = { bytes };
    this.#collected?.register(receiver, share, share);
    return share;
  }

  /** `bytes` were read or dropped; `share` is their body's, once it has ended. */
  remove(bytes: number, share?: EndedShare): void {
    if (bytes === 0) return;
    this.#release(bytes, share);
  }

  #release(bytes: number, share: EndedShare | undefined): void {
    if (share) {
      // A finalizer runs at most once and only for a share still registered, but stay exact.
      bytes = Math.min(bytes, share.bytes);
      if (bytes === 0) return;
      share.bytes -= bytes;
      this.#endedBytes -= bytes;
      if (share.bytes === 0) this.#collected?.unregister(share);
    }
    this.#counters.queuedBytes -= bytes;
    if (this.#held.size > 0 && this.#counters.queuedBytes <= this.maxBytes) {
      const held = [...this.#held];
      this.#held.clear();
      for (const receiver of held) receiver.flushAcks();
    }
  }

  /** Whether `receiver`, with `backlog` bytes of its own queued, must hold back its ack for now. */
  holds(receiver: BodyReceiver, backlog: number): boolean {
    if (backlog === 0 || this.#counters.queuedBytes <= this.maxBytes) {
      this.#held.delete(receiver);
      return false;
    }
    if (!this.#held.has(receiver)) {
      this.#held.add(receiver);
      this.#counters.acksWithheld++;
    }
    return true;
  }

  forget(receiver: BodyReceiver): void {
    this.#held.delete(receiver);
  }
}

/**
 * The coalesced-ack timer of one connection (`ackCoalesce`), shared by every body it receives. A
 * body with consumed bytes not yet acknowledged joins the due set; one timer per connection flushes
 * the whole set `delayMs` after the first of them joined, so each ack goes out at most `delayMs`
 * after its first byte was consumed. A body that ends, reaches `bytes` or flushes otherwise leaves
 * the set, and the timer is never cleared or re-armed per body: a short response (one chunk, then
 * its end) costs a set insertion and removal, not a timer of its own. A timer armed and cleared
 * per request cost about 3 µs of client-thread CPU per 4 KiB request (bench/transport,
 * fetch-json-4k, profiled), which made `ackCoalesce` lose 7 to 11% of small-request throughput.
 * Once it fires with nothing due, the timer is not re-armed until a body has bytes to acknowledge.
 */
export class AckCoalescer {
  readonly bytes: number;
  readonly delayMs: number;
  readonly #due = new Set<BodyReceiver>();
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor({ bytes, delayMs }: AckCoalesceOptions) {
    this.bytes = bytes;
    this.delayMs = delayMs;
  }

  /** `receiver` has consumed bytes to acknowledge: flush it with the next tick of the timer. */
  schedule(receiver: BodyReceiver): void {
    this.#due.add(receiver);
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(this.#fire, this.delayMs);
    // A pending ack must not keep a process alive; browsers' timers have no `unref`.
    if (typeof this.#timer === "object" && typeof this.#timer.unref === "function") this.#timer.unref();
  }

  /** `receiver` flushed or stopped acknowledging; it is no longer due. */
  forget(receiver: BodyReceiver): void {
    this.#due.delete(receiver);
  }

  readonly #fire = (): void => {
    this.#timer = undefined;
    if (this.#due.size === 0) return;
    const due = [...this.#due];
    this.#due.clear();
    for (const receiver of due) receiver.flushAcks();
  };
}

export interface BodyReceiverOptions {
  /** Sends an ack for `bytes` consumed. */
  ack: (bytes: number) => void;
  /** The consumer cancelled the stream. */
  onCancel: (reason: unknown) => void;
  /**
   * A chunk would have queued more than the whole connection budget for this one body: the sender
   * ignores flow control (or its window exceeds `maxQueuedBytes`). The chunk was dropped; the
   * caller fails the request.
   */
  onOverflow: () => void;
  budget: ReceiveBudget;
  counters: Counters;
  /** Coalesce acks through the connection's timer; without it each consumed chunk is acked at once. */
  coalesce?: AckCoalescer;
}

/**
 * The receiver's half: a `ReadableStream` fed by incoming chunks that acknowledges each chunk when
 * the consumer takes it (not when it arrives), so the sender's window measures what is still
 * buffered here. With `coalesce`, consumed bytes accumulate and go out as one ack once `bytes` are
 * reached or `delayMs` after the first of them, whichever comes first; acks only ever cover bytes
 * consumed. Once the body is over (its sender's `end()`, `stopAcks()`, `finish()`, `error()`,
 * cancel) no ack is sent and nothing of it is left on the connection's timer.
 */
export class BodyReceiver {
  readonly stream: ReadableStream<Uint8Array>;
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  #queue: Uint8Array[] = [];
  #queuedBytes = 0;
  #ended = false;
  /** This body's share of `endedBytes`, once it ended with bytes queued. */
  #share: EndedShare | undefined;
  #waiting = false;
  #done = false;
  #acksStopped = false;
  #pendingAck = 0;
  #pendingCount = 0;
  readonly #options: BodyReceiverOptions;

  constructor(options: BodyReceiverOptions) {
    this.#options = options;
    this.stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.#controller = controller;
        },
        pull: () => {
          const chunk = this.#queue.shift();
          if (chunk) {
            this.#queuedBytes -= chunk.byteLength;
            options.budget.remove(chunk.byteLength, this.#share);
            this.#deliver(chunk);
          } else if (this.#ended) this.#close();
          else this.#waiting = true;
        },
        cancel: (reason) => {
          this.#done = true;
          this.#drop();
          options.onCancel(reason);
        },
      },
      // Only pull when a read is pending, so acks track consumption.
      { highWaterMark: 0 },
    );
  }

  push(chunk: Uint8Array): void {
    if (this.#done || this.#ended) return;
    if (this.#waiting) {
      this.#waiting = false;
      this.#deliver(chunk);
      return;
    }
    if (this.#queuedBytes + chunk.byteLength > this.#options.budget.maxBytes) {
      this.#options.onOverflow();
      return;
    }
    this.#queue.push(chunk);
    this.#queuedBytes += chunk.byteLength;
    this.#options.budget.add(chunk.byteLength);
  }

  /**
   * The sender sent its last chunk. It no longer waits for credit, so acks would reach nobody: they
   * stop here, with what is pending dropped, while the queue can still be read.
   */
  end(): void {
    if (this.#ended || this.#done) return;
    this.stopAcks();
    this.#ended = true;
    this.#share = this.#options.budget.ended(this, this.#queuedBytes);
    if (this.#waiting && this.#queue.length === 0) this.#close();
  }

  /**
   * Ends the body whether or not the sender finished: queued chunks are dropped, a pending read
   * settles with `done`, later reads do too. For a request whose response is already complete,
   * so a handler still reading the upload stops instead of waiting for chunks that stopped coming.
   */
  finish(): void {
    if (this.#done) return;
    this.#drop();
    this.#ended = true;
    if (this.#waiting) this.#close();
  }

  error(err: unknown): void {
    if (this.#done) return;
    this.#done = true;
    this.#drop();
    this.#controller.error(err);
  }

  /**
   * The sender is done with this body (the request completed): what is queued can still be read,
   * but acks would reach nobody, so none are sent and pending ones are dropped with their timer.
   */
  stopAcks(): void {
    if (this.#acksStopped) return;
    this.#acksStopped = true;
    this.#pendingAck = 0;
    this.#pendingCount = 0;
    this.#options.coalesce?.forget(this);
    this.#options.budget.forget(this);
  }

  /** Sends the consumed bytes not yet acknowledged, unless the connection budget holds them back. */
  flushAcks(): void {
    this.#options.coalesce?.forget(this);
    if (this.#acksStopped || this.#pendingAck === 0) return;
    if (this.#options.budget.holds(this, this.#queuedBytes)) return;
    const bytes = this.#pendingAck;
    this.#options.counters.acksCoalesced += this.#pendingCount - 1;
    this.#pendingAck = 0;
    this.#pendingCount = 0;
    this.#options.ack(bytes);
  }

  #deliver(chunk: Uint8Array): void {
    this.#controller.enqueue(chunk);
    this.#consumed(chunk.byteLength);
  }

  #consumed(bytes: number): void {
    if (this.#acksStopped) return;
    this.#pendingAck += bytes;
    this.#pendingCount++;
    const { coalesce } = this.#options;
    if (!coalesce || this.#pendingAck >= coalesce.bytes) this.flushAcks();
    else coalesce.schedule(this);
  }

  /** Drops the queue and everything ack-related; the stream itself is settled by the caller. */
  #drop(): void {
    this.stopAcks();
    this.#queue = [];
    const queued = this.#queuedBytes;
    this.#queuedBytes = 0;
    this.#options.budget.remove(queued, this.#share);
  }

  #close(): void {
    if (this.#done) return;
    this.#done = true;
    this.#waiting = false;
    this.#controller.close();
  }
}
