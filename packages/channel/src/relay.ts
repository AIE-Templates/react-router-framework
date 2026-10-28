import {
  type Channel,
  type ChannelCloseInfo,
  CLOSE_CODES,
  drainedNow,
  frameBytes,
  isCloseCode,
  opened,
} from "./channel.ts";
import { checkInteger, checkMs, now } from "./options.ts";

export interface Relay {
  /**
   * Closes both channels at once, dropping frames still queued in the relay. `code` must be an
   * integer in 1000–4999 (a `RangeError` otherwise, and the relay is left as it was).
   */
  close(code?: number, reason?: string): void;
  /** Resolves once both channels are closed. */
  done: Promise<void>;
  /** A snapshot of the relay's counters, built when called (the counting itself runs as frames pass). */
  stats(): RelayStats;
}

export interface RelayStats {
  /** Frames from the first channel given to `relay()` to the second. */
  aToB: RelayDirectionStats;
  bToA: RelayDirectionStats;
  /**
   * Overload closes (0 or 1): more than `maxPendingBytes` held for an unopened destination (1011),
   * or more than `maxQueuedFrames` frames queued in one direction (4008).
   */
  overloadCloses: number;
}

export interface RelayDirectionStats {
  /** Frames and bytes forwarded (sent on the destination). */
  frames: number;
  bytes: number;
  /**
   * Bytes queued in the relay right now: waiting for the destination to open, to drain, or for the
   * next turn.
   */
  heldBytes: number;
  /** How often forwarding stopped at the end of a quantum to let the event loop run. */
  yields: number;
}

export interface RelayOptions {
  /**
   * Bytes of frames held for a destination that has not opened yet, beyond which the relay gives up
   * and closes both ends with `CLOSE_CODES.internalError`. Defaults to 1 MiB. The first held frame is
   * always accepted whatever its size, so a single large frame sent during connection setup does
   * not fail the relay; the limit bounds what accumulates behind it.
   */
  maxPendingBytes?: number;
  /**
   * Frames one direction may hold queued (for an unopened or undrained destination, or the next
   * turn), beyond which the relay closes both ends with `CLOSE_CODES.overloaded` (4008). A bound on
   * the relay's per-frame bookkeeping, which byte budgets miss: an empty frame counts 0 bytes
   * everywhere (on the wire, in windows and in `maxPendingBytes`), so without it a producer that
   * awaits `whenDrained()` could queue empty frames without end. Defaults to 32768: a queued frame
   * costs about 1.2 KB of heap in the relay's process (its queue entry and the source channel's
   * pending-message state, measured on Node 24 with empty frames), so about 38 MiB at the limit,
   * and a producer kept within a 1 MiB window or `maxPendingBytes` never reaches it unless its
   * frames average under 32 bytes.
   */
  maxQueuedFrames?: number;
  /**
   * How long a side may still be connecting after the relay was created. A side that has not opened
   * by then (a peer that keeps the transport alive but never completes the handshake) closes both
   * ends with `CLOSE_CODES.internalError` and a reason. Defaults to 10 seconds.
   */
  openTimeoutMs?: number;
  /**
   * Bytes one direction forwards without the event loop getting a turn. Past it, further frames
   * are queued (in order) and forwarded after a yield, so a close, acknowledgements and the other
   * direction are not stuck behind a long burst. Checked between frames, so a frame is never split
   * and one turn may forward up to the quantum plus one frame. Defaults to 64 KiB.
   */
  quantumBytes?: number;
  /** Like `quantumBytes`, in milliseconds of continuous forwarding. Defaults to 1 ms. */
  quantumMs?: number;
  /**
   * Close codes (each an integer in 1000–4999) that stop the relay at once: a close with one of
   * them from either side drops the frames queued in both directions and reaches the other side
   * immediately, instead of following the data its sender queued before it. For a consumer's
   * "cancel" code, when the consumer may itself have a backlog waiting in the relay. Defaults to
   * none: every close without `error` follows its sender's data, as on a WebSocket.
   */
  abortCodes?: readonly number[];
}

/**
 * Pumps frames between two channels in both directions until either closes, closing the other
 * with the same code and reason; a close the source chose (any code, no error) follows the frames
 * its side sent before it unless its code is in `abortCodes`, a failure stops at once (see
 * `propagate` below). Both directions are wired at
 * once: a frame that arrives before its destination is open is held (its source's acknowledgement
 * with it) and forwarded once the destination opens, so nothing sent during connection setup is
 * lost. A side that never opens
 * (closes first, exceeds `maxPendingBytes` of held frames, or is still connecting after
 * `openTimeoutMs`) is a setup failure: both ends are closed with 1011 and a reason. A channel that
 * is already closed when the relay is created is treated the same way at once; one already open
 * counts as opened, so its own close propagates with its code and reason. Backpressure: a direction
 * forwards only while its destination is drained (what `whenDrained()` reports); once a forwarded
 * frame leaves the destination above its low-water mark, further frames stay queued in the relay,
 * in order, until it drains, and the source's acknowledgement of every frame not yet forwarded, and
 * of the frame that filled the destination, is held until then (port channels hold the ack while a
 * handler's promise is pending; WebSocket channels pause or close when too much is pending). So the
 * destination's window, not the source's, bounds what the relay puts on it, and a fast producer is
 * slowed to the slow consumer's pace instead of filling memory. Scheduling: each direction forwards
 * in FIFO order and yields to the event loop after `quantumBytes` or `quantumMs` of continuous
 * forwarding. The utility process does this between the renderer's port channel and the gateway's
 * WebSocket.
 */
export function relay(a: Channel, b: Channel, options: RelayOptions = {}): Relay {
  const {
    maxPendingBytes = 1024 * 1024,
    maxQueuedFrames = 32_768,
    openTimeoutMs = 10_000,
    quantumBytes = 64 * 1024,
    quantumMs = 1,
    abortCodes = [],
  } = options;
  checkInteger("maxPendingBytes", maxPendingBytes, 0);
  checkInteger("maxQueuedFrames", maxQueuedFrames, 1);
  checkMs("openTimeoutMs", openTimeoutMs, { positive: true });
  checkInteger("quantumBytes", quantumBytes, 1);
  checkMs("quantumMs", quantumMs, { positive: false });
  for (const code of abortCodes) {
    if (!isCloseCode(code)) throw new RangeError(`abortCodes must be integers in 1000–4999, got ${String(code)}`);
  }
  const aborting = new Set(abortCodes);

  let closing = false;
  let overloadCloses = 0;
  // Both directions stop at once: what is queued is dropped, its acknowledgements released.
  const stop = () => {
    aToB.stop();
    bToA.stop();
  };
  const closeBoth = (code: number, reason?: string) => {
    if (closing) return;
    closing = true;
    stop();
    try {
      a.close(code, reason);
    } finally {
      b.close(code, reason);
    }
  };
  // A side that goes away before it ever opened is a setup failure (1011), whatever its transport
  // reported; a side that was open closes the other with its own code and reason. The channel
  // itself records that it opened (`everOpened`, set before its open handlers run), so a close
  // issued inside an `onOpen` handler, or before this relay existed, is classified correctly.
  // A close the source chose (any code, no error) ends its stream, as on a WebSocket, where the close
  // frame follows the data: it reaches the destination only after the frames its side sent before it,
  // which may still be queued for the next turn or an unopened destination; the other direction's
  // queue, toward the closed side, is dropped. So a "cancel" close from a side with outbound backlog
  // also arrives after that backlog. A failure (`error` set) or a code in `abortCodes` stops at once
  // and drops the queues of both directions.
  const propagate = (from: Channel, to: Channel, forwarder: Forwarder) => (info: ChannelCloseInfo) => {
    if (closing) return;
    if (!from.everOpened) {
      closing = true;
      stop();
      to.close(CLOSE_CODES.internalError, "The other side did not open");
      return;
    }
    const code = info.code ?? CLOSE_CODES.normal;
    const close = () => {
      if (closing) return;
      closing = true;
      stop();
      to.close(code, info.reason);
    };
    if (info.error === undefined && !aborting.has(code)) forwarder.end(close);
    else close();
  };
  const tooMuchHeld = (held: number) => {
    overloadCloses++;
    closeBoth(
      CLOSE_CODES.internalError,
      `Held ${held} bytes for a destination that had not opened, more than ${maxPendingBytes}`,
    );
  };
  const tooManyQueued = (frames: number) => {
    overloadCloses++;
    closeBoth(CLOSE_CODES.overloaded, `Queued ${frames} frames in the relay, more than ${maxQueuedFrames}`);
  };

  const done = Promise.all([closed(a), closed(b)]).then(() => undefined);

  const forwarderOptions = { maxPendingBytes, maxQueuedFrames, quantumBytes, quantumMs, tooMuchHeld, tooManyQueued };
  const aToB = new Forwarder(b, forwarderOptions);
  const bToA = new Forwarder(a, forwarderOptions);
  a.onMessage((data) => aToB.push(data));
  b.onMessage((data) => bToA.push(data));
  a.onClose(propagate(a, b, aToB));
  b.onClose(propagate(b, a, bToA));

  // A channel that was closed before the relay existed will never fire `onClose` for it.
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    if (from.state === "closed" && !closing) {
      closing = true;
      to.close(CLOSE_CODES.internalError, "The other side was already closed");
    }
  }

  // The open deadline: a side still connecting by then never will.
  const connecting = [a, b].filter((channel) => channel.state === "connecting");
  if (connecting.length > 0 && !closing) {
    const timer = setTimeout(() => {
      if (closing) return;
      if ([a, b].some((channel) => channel.state === "connecting")) {
        closeBoth(CLOSE_CODES.internalError, `The other side did not open within ${openTimeoutMs} ms`);
      }
    }, openTimeoutMs);
    void Promise.all(connecting.map((channel) => opened(channel).catch(() => {}))).then(() => clearTimeout(timer));
    void done.then(() => clearTimeout(timer));
  }

  return {
    close(code = CLOSE_CODES.normal, reason?: string) {
      // Checked before any state changes, so a rejected call leaves the relay closable.
      if (!isCloseCode(code)) throw new RangeError(`A close code must be an integer in 1000–4999, got ${String(code)}`);
      closeBoth(code, reason);
    },
    done,
    stats: () => ({ aToB: aToB.stats(), bToA: bToA.stats(), overloadCloses }),
  };
}

interface QueuedFrame {
  data: string | Uint8Array;
  bytes: number;
  /**
   * Releases the source's acknowledgement: at once, or with the destination's drain promise when
   * the frame left the destination above its low-water mark.
   */
  release: (drained?: Promise<void>) => void;
}

/** Gives the event loop a turn: I/O (port messages, socket data) runs before the callback. */
const nextTurn: (callback: () => void) => void =
  typeof setImmediate === "function" ? (callback) => setImmediate(callback) : (callback) => setTimeout(callback, 0);

/** Forwarded slots at the front of the queue array past which it is compacted (see `#pump`). */
const COMPACT_AFTER = 1024;

export interface ForwarderOptions {
  maxPendingBytes: number;
  maxQueuedFrames: number;
  quantumBytes: number;
  quantumMs: number;
  tooMuchHeld: (held: number) => void;
  tooManyQueued: (frames: number) => void;
}

/**
 * One direction of a relay: forwards frames to `to` in FIFO order, holds them while `to` is
 * connecting or not drained, and stops for a turn of the event loop after a quantum of continuous
 * forwarding. Exported for tests only (not from the package index).
 */
export class Forwarder {
  readonly #to: Channel;
  readonly #maxPendingBytes: number;
  readonly #maxQueuedFrames: number;
  readonly #quantumBytes: number;
  readonly #quantumMs: number;
  readonly #tooMuchHeld: (held: number) => void;
  readonly #tooManyQueued: (frames: number) => void;
  /**
   * Frames not forwarded yet are `#queue[#head..]`; forwarded slots before `#head` are cleared and
   * the array is compacted once they are more than `COMPACT_AFTER` and half of it, so its length
   * stays proportional to what is queued even when the queue never empties.
   */
  #queue: (QueuedFrame | undefined)[] = [];
  #head = 0;
  #held = 0;
  #waitingForOpen = false;
  /**
   * A `whenDrained()` of the destination is pending: nothing is forwarded until it resolves (which
   * it also does when the destination closes). Started whenever the destination is found not
   * drained, before a send or after one.
   */
  #waitingForDrain = false;
  /**
   * For a destination that cannot say synchronously whether it is drained: its `whenDrained()` has
   * just resolved, which admits one frame. Valid only during the pump that resolution runs: kept
   * across an idle period or a quantum yield it would admit a frame after another writer had filled
   * the destination again.
   */
  #drainConfirmed = false;
  /** The relay is closing: nothing more is forwarded or queued. */
  #stopped = false;
  /** The source closed normally: called once everything queued before that was forwarded. */
  #onEnd: (() => void) | undefined;
  /** Bytes forwarded since the event loop last had a turn, and when that run started. */
  #sliceBytes = 0;
  #sliceStart = 0;
  /** A `nextTurn` is pending: it ends the current slice and resumes the queue. */
  #turnPending = false;
  #frames = 0;
  #bytes = 0;
  #yields = 0;

  constructor(to: Channel, options: ForwarderOptions) {
    this.#to = to;
    this.#maxPendingBytes = options.maxPendingBytes;
    this.#maxQueuedFrames = options.maxQueuedFrames;
    this.#quantumBytes = options.quantumBytes;
    this.#quantumMs = options.quantumMs;
    this.#tooMuchHeld = options.tooMuchHeld;
    this.#tooManyQueued = options.tooManyQueued;
  }

  stats(): RelayDirectionStats {
    return { frames: this.#frames, bytes: this.#bytes, heldBytes: this.#held, yields: this.#yields };
  }

  /** Frames queued, and the length of the array holding them (forwarded slots included); for tests. */
  get queueStorage(): { queued: number; slots: number } {
    return { queued: this.#queue.length - this.#head, slots: this.#queue.length };
  }

  /** The source's message handler: the promise it returns holds the source's acknowledgement. */
  push(data: string | Uint8Array): Promise<void> | undefined {
    if (this.#stopped) return undefined;
    const to = this.#to;
    const bytes = frameBytes(data);
    // Fast path: nothing queued ahead of it, the quantum not used up and the destination drained
    // right now (checked, not assumed: it may have been filled before the relay existed, or by
    // another writer). A destination that is still drained afterwards (the common case) costs no promise.
    if (to.state === "open" && this.#head === this.#queue.length && this.#withinQuantum() && this.#mayForward()) {
      this.#forward(data, bytes);
      return this.#afterForward();
    }
    if (to.state === "closing" || to.state === "closed") return undefined; // Its close handler takes the relay down.
    if (to.state === "connecting" && this.#held > 0 && this.#held + bytes > this.#maxPendingBytes) {
      this.#tooMuchHeld(this.#held + bytes);
      return undefined;
    }
    const queued = this.#queue.length - this.#head;
    if (queued >= this.#maxQueuedFrames) {
      this.#tooManyQueued(queued + 1);
      return undefined;
    }
    return new Promise<void>((resolve) => {
      this.#queue.push({ data, bytes, release: (drained) => resolve(drained) });
      this.#held += bytes;
      this.#pump();
    });
  }

  /**
   * The source closed normally: `callback` runs once every frame queued so far was forwarded (at
   * once if none is), not at all if the destination goes away first.
   */
  end(callback: () => void): void {
    if (this.#head === this.#queue.length) callback();
    else this.#onEnd = callback;
  }

  /** The relay is closing: drop what is queued (releasing its acknowledgements) and forward nothing more. */
  stop(): void {
    this.#stopped = true;
    this.#dropAll();
  }

  #pump(): void {
    const to = this.#to;
    while (this.#head < this.#queue.length) {
      if (this.#stopped) return;
      if (to.state === "connecting") {
        void this.#awaitOpen();
        return;
      }
      if (to.state !== "open") {
        this.#dropAll();
        return;
      }
      if (!this.#withinQuantum()) return; // The pending turn resumes the queue.
      if (!this.#mayForward()) return; // The drain resumes the queue.
      const frame = this.#queue[this.#head];
      if (frame === undefined) break;
      this.#queue[this.#head++] = undefined; // Released for GC; the array is reset once drained.
      if (this.#head >= COMPACT_AFTER && this.#head * 2 >= this.#queue.length) {
        // Amortized: the slots copied are at most the ones forwarded since the last compaction.
        this.#queue = this.#queue.slice(this.#head);
        this.#head = 0;
      }
      this.#held -= frame.bytes;
      this.#forward(frame.data, frame.bytes);
      frame.release(this.#afterForward());
    }
    this.#queue = [];
    this.#head = 0;
    const onEnd = this.#onEnd;
    this.#onEnd = undefined;
    onEnd?.();
  }

  /**
   * Admission: whether the open destination may take a frame now. A package channel answers
   * synchronously (`DRAINED`); any other channel admits one frame per resolved `whenDrained()`.
   * When it may not, a wait is started (once) that resumes the queue.
   */
  #mayForward(): boolean {
    if (this.#waitingForDrain) return false;
    const drained = drainedNow(this.#to);
    if (drained === true) return true;
    if (drained === undefined && this.#drainConfirmed) {
      this.#drainConfirmed = false;
      return true;
    }
    void this.#waitForDrain();
    return false;
  }

  /**
   * After a frame went out: `undefined` if the destination is still drained, otherwise its drain
   * promise, which the source's acknowledgement waits for and which resumes forwarding.
   */
  #afterForward(): Promise<void> | undefined {
    if (drainedNow(this.#to) === true) return undefined;
    // Not drained, or a channel that cannot say so synchronously: wait for it.
    return this.#waitForDrain();
  }

  #waitForDrain(): Promise<void> {
    const promise = this.#to.whenDrained();
    this.#waitingForDrain = true;
    this.#drainConfirmed = false;
    void promise.then(this.#onDrained, this.#onDrained);
    return promise;
  }

  readonly #onDrained = (): void => {
    this.#waitingForDrain = false;
    this.#drainConfirmed = true;
    // The destination may have closed meanwhile (a close also resolves the drain): `#pump` checks,
    // and a package channel's drain state is checked again before the next frame.
    this.#pump();
    this.#drainConfirmed = false;
  };

  #forward(data: string | Uint8Array, bytes: number): void {
    if (!this.#turnPending) {
      // A new slice: the event loop had a turn since the last forward.
      this.#turnPending = true;
      this.#sliceBytes = 0;
      this.#sliceStart = now();
      nextTurn(() => {
        // Frames still queued for an open, drained destination: forwarding stopped for this turn.
        if (this.#head < this.#queue.length && this.#to.state === "open" && !this.#waitingForDrain) this.#yields++;
        this.#turnPending = false;
        this.#sliceBytes = 0;
        this.#pump();
      });
    }
    this.#sliceBytes += bytes;
    this.#frames++;
    this.#bytes += bytes;
    this.#to.send(data);
  }

  #withinQuantum(): boolean {
    if (!this.#turnPending) return true;
    return this.#sliceBytes < this.#quantumBytes && now() - this.#sliceStart < this.#quantumMs;
  }

  async #awaitOpen(): Promise<void> {
    if (this.#waitingForOpen) return;
    this.#waitingForOpen = true;
    try {
      await opened(this.#to);
    } catch {
      this.#dropAll(); // The destination closed; its close handler already took the relay down.
      return;
    } finally {
      this.#waitingForOpen = false;
    }
    this.#pump();
  }

  /** The destination is gone: release every held acknowledgement (the relay is closing anyway). */
  #dropAll(): void {
    const queue = this.#queue;
    const head = this.#head;
    this.#queue = [];
    this.#head = 0;
    this.#held = 0;
    this.#onEnd = undefined;
    for (let i = head; i < queue.length; i++) queue[i]?.release();
  }
}

function closed(channel: Channel): Promise<void> {
  return new Promise((resolve) => {
    if (channel.state === "closed") resolve();
    else channel.onClose(() => resolve());
  });
}
