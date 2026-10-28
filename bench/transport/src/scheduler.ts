import { Histogram, round } from "./histogram.ts";

/**
 * An open-loop sender: `ratePerSec` frames on an absolute timetable, whatever the transport does.
 * Each frame remembers when it was due (`intendedAt`), when it was admitted and handed to the
 * transport (`sentAt`: after any backpressure wait, before encoding and the transport's `send`) and
 * when it completed (`completedAt`, from the receiver's acknowledgement or the RPC response).
 * Latency is measured from the intended time, so a slow transport shows up as growing latency
 * instead of silently sending less (coordinated omission); the gap between intended and sent is
 * reported separately as lateness, and the synchronous cost of the send itself (encode, structured
 * clone, socket write) is inside `fromSent` and also reported alone as `sendCostMs`. Timers come
 * from one monotonic clock and fire in short slices that catch up on every frame due so far,
 * rather than one timer per frame.
 *
 * The send loop is cooperative: a stretch of frames handed to the transport without the event loop
 * getting a turn (no wait for credit, drain or the timetable in between: bulk, or catching up) ends
 * after `budget.bytes` or `budget.ms`, whichever comes first, with a real macrotask turn
 * (`setImmediate`, not a resolved promise), so this thread's own I/O (acknowledgements, credits,
 * responses) is handled while it sends. Without it a bulk sender whose admission never has to wait
 * starves its own acknowledgement callbacks and measures that as transport latency.
 */
export interface ScheduledFrame {
  readonly seq: number;
  readonly intendedAt: number;
  sentAt: number;
  completedAt: number;
}

export interface SchedulerOptions {
  ratePerSec: number;
  /** Stop after this many frames (bulk) or when `until()` says so. */
  maxFrames?: number;
  /** Frames are considered timed out when not completed within this (counted, not recorded). */
  timeoutMs?: number;
  /** A frame is late when it goes out more than this after its intended time. */
  lateThresholdMs?: number;
  /**
   * Only every `sampleEvery`-th frame (by `seq`) is completed by the receiver, so only those are
   * tracked for latency and timeouts; the others are never pending. Defaults to 1 (every frame).
   */
  sampleEvery?: number;
  /** Bytes each `send` hands to the transport, counted against `budget.bytes`. Defaults to 0. */
  frameBytes?: number;
  /** Continuous work allowed before a forced macrotask turn. Defaults to `DEFAULT_SEND_BUDGET`. */
  budget?: SendBudget;
  /**
   * Stop at the deadline even when frames due before it were not sent yet (the sender fell behind
   * its timetable); they are counted as `abandoned` instead of being caught up after the deadline.
   * The check is made before admission, so a frame whose admission wait (credit, drain) began
   * before the deadline is still sent when it ends, up to one frame past the deadline.
   * Off by default: every frame due before the deadline is sent, however late.
   */
  stopAtDeadline?: boolean;
}

/** Bytes sent or milliseconds spent without an event-loop turn, whichever runs out first. */
export interface SendBudget {
  bytes: number;
  ms: number;
}

/**
 * 1 MiB or 1 ms. A 64 KiB byte budget (a turn after every bulk-64k frame) cost the `worker` link
 * about half its bulk-64k throughput for a few tenths of a millisecond of `ws` latency; with 1 MiB,
 * `ws` bulk latency stays at a few milliseconds and the `worker` raw variant loses about a fifth of
 * its bulk-64k throughput (the package variant's loss is within run-to-run noise).
 */
export const DEFAULT_SEND_BUDGET: SendBudget = { bytes: 1024 * 1024, ms: 1 };

export interface SchedulerStats {
  offered: number;
  sent: number;
  completed: number;
  timedOut: number;
  late: number;
  maxLatenessMs: number;
  /** The generator fell more than a second behind its timetable at some point. */
  generatorLimited: boolean;
  /** Latency from the intended send time to completion. */
  fromIntended: ReturnType<Histogram["summary"]>;
  /**
   * Latency from admission (credit granted, just before encode + send) to completion: the
   * transport's own round trip, its synchronous send cost included.
   */
  fromSent: ReturnType<Histogram["summary"]>;
  /** Intended time to admission: timetable slip and backpressure waits. */
  latenessMs: ReturnType<Histogram["summary"]>;
  /** Admission to the return of `send` (encode, structured clone or socket write, on this thread). */
  sendCostMs: ReturnType<Histogram["summary"]>;
  /** Macrotask turns forced because a stretch of sending used up the budget. */
  yields: number;
  /**
   * The longest stretch the loop ran without the event loop getting a turn (forced or because it
   * waited for credit, drain or the timetable): admission, encoding and sends, back to back.
   */
  maxBurstMs: number;
  /** With `stopAtDeadline`: frames due before the deadline that were never sent. */
  abandoned?: number;
  /**
   * Tracked frames still waiting for completion when the run was cut short (`censor()`: a cancel or
   * a close). Each is recorded in `fromIntended`/`fromSent` at its age then, a lower bound of its
   * latency, so the percentiles do not lose the slowest frames; this counts them. Absent in files
   * from before censoring.
   */
  censored?: number;
}

export class Scheduler {
  readonly #fromIntended = new Histogram();
  readonly #fromSent = new Histogram();
  readonly #lateness = new Histogram();
  readonly #sendCost = new Histogram();
  readonly #pending = new Map<number, ScheduledFrame>();
  readonly #options: Required<SchedulerOptions>;
  #offered = 0;
  #sent = 0;
  #completed = 0;
  #timedOut = 0;
  #late = 0;
  #maxLateness = 0;
  #generatorLimited = false;
  #stopped = false;
  #yields = 0;
  #maxBurst = 0;
  #abandoned = 0;
  #censored = 0;
  #startedAt = 0;

  constructor(options: SchedulerOptions) {
    this.#options = {
      ratePerSec: options.ratePerSec,
      maxFrames: options.maxFrames ?? Number.POSITIVE_INFINITY,
      timeoutMs: options.timeoutMs ?? 10_000,
      lateThresholdMs: options.lateThresholdMs ?? 5,
      sampleEvery: options.sampleEvery ?? 1,
      frameBytes: options.frameBytes ?? 0,
      budget: options.budget ?? DEFAULT_SEND_BUDGET,
      stopAtDeadline: options.stopAtDeadline ?? false,
    };
  }

  /**
   * Runs the timetable until `stop()`, `maxFrames` or the clock passes `deadline`. For each frame,
   * `admit` (optional) waits for credit or drain and may return nothing when no wait is needed; the
   * frame counts as sent when admission ends, and is tracked before `send` runs, so a completion
   * cannot overtake its registration. `send` encodes and hands the frame to the transport; it may
   * return a promise (awaited, part of the send cost) for work that follows the send, such as a cancel.
   */
  async run(
    send: (frame: ScheduledFrame) => Promise<void> | void,
    deadline: number,
    admit?: (frame: ScheduledFrame) => Promise<void> | void,
  ): Promise<void> {
    const start = performance.now();
    this.#startedAt = start;
    const interval = this.#options.ratePerSec > 0 ? 1000 / this.#options.ratePerSec : 0;
    const { budget, frameBytes } = this.#options;
    // A burst is the work since the event loop last had a turn. `turned` is set by an immediate
    // armed at the start of each burst: after an await, it tells whether the loop really went round
    // (a timer, a message, a forced yield) or the promise was already settled (a microtask).
    let burstStart = start;
    let burstBytes = 0;
    let turned = false;
    const arm = () => {
      turned = false;
      setImmediate(() => {
        turned = true;
      });
    };
    const endBurst = (at: number) => {
      if (at - burstStart > this.#maxBurst) this.#maxBurst = at - burstStart;
      burstStart = performance.now();
      burstBytes = 0;
      arm();
    };
    const wait = async (promise: Promise<void>) => {
      const before = performance.now();
      await promise;
      if (turned) endBurst(before);
    };
    arm();
    let seq = 0;
    while (!this.#stopped && seq < this.#options.maxFrames) {
      const intendedAt = interval > 0 ? start + seq * interval : performance.now();
      const now = performance.now();
      if (intendedAt > deadline) break;
      if (this.#options.stopAtDeadline && now >= deadline) {
        // Frames due by the deadline that the sender never got to: this one and every later one.
        this.#abandoned = interval > 0 ? Math.max(0, Math.floor((deadline - start) / interval) + 1 - seq) : 0;
        break;
      }
      if (intendedAt > now) {
        await wait(sleep(Math.min(intendedAt - now, 50)));
        continue;
      }
      const frame: ScheduledFrame = { seq, intendedAt, sentAt: 0, completedAt: 0 };
      this.#offered++;
      seq++;
      if (admit) {
        const waiting = admit(frame);
        if (waiting) await wait(waiting);
        if (this.#stopped) break;
      }
      const sentAt = performance.now();
      frame.sentAt = sentAt;
      this.#sent++;
      const lateness = sentAt - intendedAt;
      this.#lateness.record(lateness);
      if (lateness > this.#options.lateThresholdMs) this.#late++;
      if (lateness > this.#maxLateness) this.#maxLateness = lateness;
      if (lateness > 1000) this.#generatorLimited = true;
      if (frame.seq % this.#options.sampleEvery === 0) {
        this.#pending.set(frame.seq, frame);
        if (this.#pending.size > 100_000) this.#expire(sentAt);
      }
      const sending = send(frame);
      if (sending) await wait(sending);
      const sentEnd = performance.now();
      this.#sendCost.record(sentEnd - sentAt);
      burstBytes += frameBytes;
      if (burstBytes >= budget.bytes || sentEnd - burstStart >= budget.ms) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        this.#yields++;
        endBurst(sentEnd);
      }
    }
    endBurst(performance.now());
  }

  /** Marks `seq` complete now; frames the receiver never acknowledged stay pending. */
  complete(seq: number): void {
    const frame = this.#pending.get(seq);
    if (!frame) return;
    this.#pending.delete(seq);
    frame.completedAt = performance.now();
    this.#completed++;
    this.#fromIntended.record(frame.completedAt - frame.intendedAt);
    this.#fromSent.record(frame.completedAt - frame.sentAt);
  }

  /**
   * The run was cut short at `now` (a cancel or a close): every frame still pending is recorded at
   * its age (`now - intendedAt`, `now - sentAt`) as a lower bound of its latency, counted in
   * `censored`, and no longer pending.
   */
  censor(now: number): void {
    for (const frame of this.#pending.values()) {
      this.#fromIntended.record(now - frame.intendedAt);
      this.#fromSent.record(now - frame.sentAt);
      this.#censored++;
    }
    this.#pending.clear();
  }

  stop(): void {
    this.#stopped = true;
  }

  /** When `run()` started: the timetable's origin (frame `seq` is due at `startedAt + seq / ratePerSec`). */
  get startedAt(): number {
    return this.#startedAt;
  }

  /** With `stopAtDeadline`: frames due before the deadline that were never sent (final once `run()` returns). */
  get abandoned(): number {
    return this.#abandoned;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  stats(): SchedulerStats {
    this.#expire(performance.now());
    return {
      offered: this.#offered,
      sent: this.#sent,
      completed: this.#completed,
      timedOut: this.#timedOut,
      censored: this.#censored,
      late: this.#late,
      maxLatenessMs: round(this.#maxLateness),
      generatorLimited: this.#generatorLimited,
      fromIntended: this.#fromIntended.summary(),
      fromSent: this.#fromSent.summary(),
      latenessMs: this.#lateness.summary(),
      sendCostMs: this.#sendCost.summary(),
      yields: this.#yields,
      maxBurstMs: round(this.#maxBurst),
      ...(this.#options.stopAtDeadline ? { abandoned: this.#abandoned } : {}),
    };
  }

  /** Frames are pending in send order, so the expired ones are a prefix. */
  #expire(now: number): void {
    for (const [seq, frame] of this.#pending) {
      if (now - frame.sentAt <= this.#options.timeoutMs) return;
      this.#pending.delete(seq);
      this.#timedOut++;
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
