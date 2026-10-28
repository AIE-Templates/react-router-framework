/**
 * A consumer that is slower than its producer for good: one worker with a byte budget
 * (`bytesPerSec`), strict FIFO. Each data frame occupies the worker for `bytes / bytesPerSec` from
 * when it reaches the head of the queue (or arrives, if the worker is idle by then) and is consumed
 * when that service time has elapsed, never earlier and never in parallel with another frame. The
 * schedule runs on a virtual clock (`freeAt`, the moment the worker finishes what it has), so timer
 * lateness never lowers the rate: a late timer consumes every frame whose service has ended.
 *
 * `pushFrame()` returns a promise that settles when that frame is consumed (the package variant's
 * handler returns it, so the channel acknowledges the frame only then; the raw variant returns its
 * credit from `consume`, at the same moment). Control items queue behind the frames that arrived
 * before them and cost no time. From `unlimitedFrom(at)` on, frames that start at or after `at` cost
 * nothing (the consumer recovered); a frame already in service finishes its own time.
 */
export interface Clock {
  now(): number;
  /** Calls `fn` after `ms`; returns a function that cancels it. */
  setTimer(fn: () => void, ms: number): () => void;
}

export const realClock: Clock = {
  now: () => performance.now(),
  setTimer: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export interface RateConsumerOptions<T> {
  bytesPerSec: number;
  /** Called once per item, in arrival order: frames when their service ends, controls when reached. */
  consume(item: T, arrivedAt: number): void;
  /** Called whenever the queue becomes empty after holding something. */
  onIdle?(): void;
  clock?: Clock;
}

interface Entry<T> {
  item: T;
  /** Service bytes; `-1` for a control item. */
  bytes: number;
  arrivedAt: number;
  resolve?: () => void;
}

export class RateConsumer<T> {
  readonly #options: RateConsumerOptions<T>;
  readonly #clock: Clock;
  #queue: (Entry<T> | undefined)[] = [];
  #head = 0;
  #freeAt = Number.NEGATIVE_INFINITY;
  #unlimitedFrom = Number.POSITIVE_INFINITY;
  #cancelTimer: (() => void) | undefined;
  #timerAt = Number.POSITIVE_INFINITY;
  #dropped = false;
  queuedBytes = 0;
  queuedFrames = 0;
  maxQueuedBytes = 0;
  maxQueuedFrames = 0;

  constructor(options: RateConsumerOptions<T>) {
    this.#options = options;
    this.#clock = options.clock ?? realClock;
  }

  /**
   * A data frame of `bytes` service bytes. Consumed at once, with nothing returned, only when the
   * queue is empty, the worker idle and the frame costs nothing (an unlimited consumer); otherwise
   * queued, and the promise settles when it is consumed (or dropped).
   */
  pushFrame(item: T, bytes: number): Promise<void> | undefined {
    const now = this.#clock.now();
    if (this.#head === this.#queue.length && !this.#dropped) {
      const start = Math.max(this.#freeAt, now);
      if (start <= now && this.#cost(bytes, start) === 0) {
        this.#freeAt = now;
        this.#options.consume(item, now);
        return undefined;
      }
    }
    if (this.#dropped) return undefined;
    let resolve: (() => void) | undefined;
    const promise = new Promise<void>((r) => (resolve = r));
    this.#queue.push({ item, bytes, arrivedAt: now, resolve });
    this.queuedBytes += bytes;
    this.queuedFrames++;
    if (this.queuedBytes > this.maxQueuedBytes) this.maxQueuedBytes = this.queuedBytes;
    if (this.queuedFrames > this.maxQueuedFrames) this.maxQueuedFrames = this.queuedFrames;
    this.pump();
    return promise;
  }

  /** A control item: handled at once if nothing is queued, else after everything queued before it. */
  pushControl(item: T): void {
    if (this.#dropped) return;
    const now = this.#clock.now();
    if (this.#head === this.#queue.length) {
      this.#options.consume(item, now);
      return;
    }
    this.#queue.push({ item, bytes: -1, arrivedAt: now });
  }

  /**
   * From `at` (clock time) on, frames cost nothing. The caller calls `pump()` at that moment (a frame
   * waiting for its service time otherwise keeps its timer), after reading the queue if it wants it.
   */
  unlimitedFrom(at: number): void {
    this.#unlimitedFrom = at;
  }

  /** Restarts the peaks (a new measure window) from what is queued now. */
  resetPeaks(): void {
    this.maxQueuedBytes = this.queuedBytes;
    this.maxQueuedFrames = this.queuedFrames;
  }

  /** Consumes everything whose service has ended by now; arms a timer for the next one. */
  pump(): void {
    if (this.#dropped) return;
    const now = this.#clock.now();
    const queue = this.#queue;
    const hadItems = this.#head < queue.length;
    while (this.#head < queue.length) {
      const entry = queue[this.#head];
      if (!entry) break;
      if (entry.bytes >= 0) {
        const start = Math.max(this.#freeAt, entry.arrivedAt);
        const finish = start + this.#cost(entry.bytes, start);
        if (finish > now) {
          // A queue that never empties must not keep its consumed slots.
          if (this.#head > 1024 && this.#head * 2 > queue.length) {
            queue.splice(0, this.#head);
            this.#head = 0;
          }
          this.#schedule(finish);
          return;
        }
        this.#freeAt = finish;
        this.queuedBytes -= entry.bytes;
        this.queuedFrames--;
      }
      queue[this.#head] = undefined;
      this.#head++;
      this.#options.consume(entry.item, entry.arrivedAt);
      entry.resolve?.();
      if (this.#dropped) return;
    }
    queue.length = 0;
    this.#head = 0;
    if (hadItems) this.#options.onIdle?.();
  }

  /**
   * Gives up everything queued (the connection closed): settles held frames without consuming them
   * and stops the timer. Returns what was dropped; later pushes are ignored.
   */
  drop(): { bytes: number; frames: number } {
    const dropped = { bytes: this.queuedBytes, frames: this.queuedFrames };
    this.#dropped = true;
    this.#cancelTimer?.();
    this.#timerAt = Number.POSITIVE_INFINITY;
    for (let i = this.#head; i < this.#queue.length; i++) this.#queue[i]?.resolve?.();
    this.#queue = [];
    this.#head = 0;
    this.queuedBytes = 0;
    this.queuedFrames = 0;
    return dropped;
  }

  #cost(bytes: number, start: number): number {
    return start >= this.#unlimitedFrom ? 0 : (bytes / this.#options.bytesPerSec) * 1000;
  }

  /** One timer, for the earliest moment something can happen. */
  #schedule(at: number): void {
    if (this.#dropped || at >= this.#timerAt) return;
    this.#cancelTimer?.();
    this.#timerAt = at;
    this.#cancelTimer = this.#clock.setTimer(
      () => {
        this.#timerAt = Number.POSITIVE_INFINITY;
        this.pump();
      },
      Math.max(0, at - this.#clock.now()),
    );
  }
}
