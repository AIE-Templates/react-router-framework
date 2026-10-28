import { BACKLOG_SAMPLE_MS, type PeerCloseReport, type PeerConsumerStats, type PeerSample } from "./backlog.ts";
import type { RunConfig } from "./config.ts";
import { RateConsumer } from "./consumer.ts";
import type { Endpoint } from "./endpoint.ts";
import { Histogram, round } from "./histogram.ts";
import { forceGc, type ProcessMetrics, snapshot, startMetrics } from "./metrics.ts";
import {
  type ControlIn,
  type ControlMessage,
  decodeHeader,
  encodeFrame,
  FLAG_SAMPLE,
  SAMPLE_EVERY,
  HEADER_BYTES,
  isControl,
  padTo,
  parseControl,
} from "./protocol.ts";
import { Scheduler, type SchedulerStats } from "./scheduler.ts";
import { type StatsTree, statsWindow } from "./stats.ts";
import { corpus } from "./workload.ts";

/**
 * The consuming side of a stream case, the same code on every link: counts what it actually
 * consumed, acknowledges sampled frames (the sender's latency clock), answers RPCs, hands out
 * credits for the raw variant, pauses as a slow consumer, streams the reverse direction, and
 * reports its own process metrics on request.
 *
 * Consumption is strictly in arrival order. A slow consumer stops consuming altogether while it is
 * paused: the frame that finds a pause due and everything after it (frames and control messages
 * alike) wait in a queue, and are consumed, counted, acknowledged and credited only when the pause
 * ends. The package variant's handler returns a promise for queued frames, so the channel holds
 * their protocol acknowledgements until they are consumed; the raw variant's credit is returned at
 * the same moment, so both variants see the same consumer. A barrier is answered in that same order,
 * after everything that arrived before it was consumed. Without a slow consumer the queue stays
 * empty and a frame is consumed in its handler, with no allocation.
 *
 * A rate-limited consumer (`consumer` cases) is a `RateConsumer`: one byte budget, strict FIFO, each
 * frame consumed (counted, acknowledged, credited, its handler's promise settled) when its service
 * time has elapsed, so raw and package see the same consumer here too. Barriers, `measure` and
 * `stats` queue behind the frames before them, as with a pause.
 *
 * RPC requests are answered on arrival in every case, never queued behind unconsumed frames: their
 * latency is the transport's queueing (what is in flight ahead of them), not the consumer's backlog.
 *
 * The peer's measure window opens when it handles `measure` and closes `measureMs` later on its own
 * clock (or at `stats` or a close, whichever comes first); everything in `PeerStats` except
 * `consumed` and `reverse` is frozen at that moment. When the connection closes, the consumer drops
 * what it still holds and, a second later (after a forced GC), the peer sends a `PeerCloseReport`
 * through `report`, the link's side channel, since the endpoint itself is gone.
 */
export interface PeerStats {
  /** Running totals since the peer started; the sender diffs barrier replies of these. */
  consumed: { bytes: number; messages: number; lastSeq: number };
  /** Payload bytes and frames consumed inside the measure window, and its actual length (ms). */
  window?: { bytes: number; messages: number; ms: number };
  reverse?: SchedulerStats;
  /** This process over the measure window. */
  metrics?: ProcessMetrics;
  /** Wall-clock time the consumer was paused inside the window (ms; pauses never overlap). */
  pausedMs: number;
  /** Pauses that started inside the window. */
  pauses: number;
  /** Time to consume one frame (decode, touch, count, ack, credit), waiting excluded (ms). */
  handleMs: ReturnType<Histogram["summary"]>;
  /**
   * Slow consumer: arrival to the start of consumption, for frames that waited behind a pause;
   * rate-limited consumer: arrival to consumption, service time included, for every frame (ms).
   */
  gateWaitMs?: ReturnType<Histogram["summary"]>;
  /** The peer channel's `stats()` over the measure window (package variant). */
  transport?: StatsTree;
  /** `consumer` cases: the rate-limited consumer's queue over the window. */
  consumer?: PeerConsumerStats;
}

type Frozen = Omit<PeerStats, "consumed" | "reverse">;

export function runPeer(
  endpoint: Endpoint,
  config: RunConfig,
  report?: (report: PeerCloseReport) => void,
): { stop(): void } {
  const { caseSpec, variant, windowBytes, seed } = config;
  const slow = caseSpec.slowConsumer;
  const rateSpec = caseSpec.consumer;
  let bytes = 0;
  let messages = 0;
  let lastSeq = -1;
  let creditSinceLast = 0;
  let handle = new Histogram();
  let gateWait = new Histogram();
  let pausedMs = 0;
  let pauses = 0;
  let metrics = startMetrics();
  const counters = statsWindow(() => endpoint.stats?.());
  let reverse: { scheduler: Scheduler; stop: () => void } | undefined;
  const creditThreshold = Math.max(1, Math.floor(windowBytes / 4));

  // The measure window.
  let windowStart = 0;
  let windowBase = { bytes: 0, messages: 0 };
  let windowTimer: ReturnType<typeof setTimeout> | undefined;
  let frozen: Frozen | undefined;

  // The slow consumer's gate: while `paused` or while `queue` is non-empty, arrivals queue up.
  const queue: (Uint8Array | ControlMessage)[] = [];
  const queuedAt: number[] = [];
  let paused = false;
  let pauseStartedAt = 0;
  let nextPauseAt = slow ? performance.now() + slow.everyMs : Number.POSITIVE_INFINITY;
  let drained: Promise<void> | undefined;
  let resolveDrained: (() => void) | undefined;

  // The rate-limited consumer and its window measurements.
  const rated = rateSpec
    ? new RateConsumer<Uint8Array | ControlMessage>({
        bytesPerSec: rateSpec.bytesPerSec,
        consume: (item, arrivedAt) => {
          if (item instanceof Uint8Array) {
            gateWait.record(performance.now() - arrivedAt);
            consume(item);
          } else onControl(item);
        },
        onIdle: () => {
          if (recovery && recovery.queueEmptyAfterMs === null && !frozen) {
            const now = performance.now();
            if (now >= recoveryAt) recovery.queueEmptyAfterMs = round(now - recoveryAt);
          }
        },
      })
    : undefined;
  let series: PeerSample[] = [];
  let sampler: ReturnType<typeof setInterval> | undefined;
  let recovery: PeerConsumerStats["recovery"];
  let recoveryAt = Number.POSITIVE_INFINITY;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  const sampleBacklog = (): void => {
    if (!rated) return;
    const m = process.memoryUsage();
    series.push({
      t: round(performance.now() - windowStart),
      queuedBytes: rated.queuedBytes,
      queuedFrames: rated.queuedFrames,
      consumedBytes: bytes - windowBase.bytes,
      heapUsed: m.heapUsed,
      rss: m.rss,
      arrayBuffers: m.arrayBuffers,
    });
  };

  const post = (message: ControlIn) => endpoint.send(JSON.stringify(message));

  const consume = (frame: Uint8Array): void => {
    const start = performance.now();
    const { seq, flags } = decodeHeader(frame);
    // Consume: touch the payload so the bytes are really read, like a terminal would parse them.
    let sum = 0;
    for (let i = HEADER_BYTES; i < frame.byteLength; i += 64) sum += frame[i] ?? 0;
    if (sum === -1) throw new Error("unreachable");
    bytes += frame.byteLength - HEADER_BYTES;
    messages++;
    lastSeq = seq;
    if (flags & FLAG_SAMPLE) post({ t: "ack", seq });
    if (variant === "raw") {
      creditSinceLast += frame.byteLength;
      if (creditSinceLast >= creditThreshold) {
        post({ t: "credit", bytes: creditSinceLast });
        creditSinceLast = 0;
      }
    }
    handle.record(performance.now() - start);
  };

  const pause = (now: number, pauseMs: number): void => {
    paused = true;
    pauses++;
    pauseStartedAt = now;
    nextPauseAt = now + (slow?.everyMs ?? 0);
    drained = new Promise<void>((resolve) => (resolveDrained = resolve));
    setTimeout(resume, pauseMs);
  };

  const resume = (): void => {
    const now = performance.now();
    paused = false;
    if (!frozen) pausedMs += now - Math.max(pauseStartedAt, windowStart);
    // The backlog is consumed in full before the next pause can start (with the next arrival), so
    // a pause as long as the interval still lets the consumer make progress.
    for (let i = 0; i < queue.length; i++) {
      const at = performance.now();
      const item = queue[i];
      if (item instanceof Uint8Array) {
        gateWait.record(at - (queuedAt[i] ?? at));
        consume(item);
      } else if (item) {
        onControl(item);
      }
    }
    queue.length = 0;
    queuedAt.length = 0;
    const wake = resolveDrained;
    drained = undefined;
    resolveDrained = undefined;
    wake?.();
  };

  const onFrame = (frame: Uint8Array): void | Promise<void> => {
    if (rated) return rated.pushFrame(frame, frame.byteLength - HEADER_BYTES);
    if (queue.length === 0) {
      if (!slow) {
        consume(frame);
        return undefined;
      }
      const now = performance.now();
      if (now < nextPauseAt) {
        consume(frame);
        return undefined;
      }
      pause(now, slow.pauseMs);
    }
    queue.push(frame);
    queuedAt.push(performance.now());
    return drained;
  };

  const openWindow = (): void => {
    metrics.stop();
    metrics = startMetrics();
    counters.start();
    windowStart = performance.now();
    windowBase = { bytes, messages };
    handle = new Histogram();
    gateWait = new Histogram();
    pausedMs = 0;
    pauses = 0;
    frozen = undefined;
    clearTimeout(windowTimer);
    windowTimer = setTimeout(closeWindow, config.measureMs);
    if (rated && rateSpec) {
      rated.resetPeaks();
      series = [];
      clearInterval(sampler);
      sampleBacklog();
      sampler = setInterval(sampleBacklog, BACKLOG_SAMPLE_MS);
      if (rateSpec.recoverAtFraction !== undefined) {
        recoveryAt = windowStart + rateSpec.recoverAtFraction * config.measureMs;
        recovery = undefined;
        rated.unlimitedFrom(recoveryAt);
        clearTimeout(recoveryTimer);
        // Record the queue at the moment of recovery, ahead of the consumer's own wake-up.
        recoveryTimer = setTimeout(() => {
          recovery = {
            atMs: round(recoveryAt - windowStart),
            queuedAtRecovery: { bytes: rated.queuedBytes, frames: rated.queuedFrames },
            queueEmptyAfterMs: rated.queuedFrames === 0 ? 0 : null,
          };
          rated.pump();
        }, recoveryAt - performance.now());
      }
    }
  };

  const closeWindow = (): void => {
    if (frozen || windowStart === 0) return;
    clearTimeout(windowTimer);
    const now = performance.now();
    if (paused) pausedMs += now - Math.max(pauseStartedAt, windowStart);
    clearInterval(sampler);
    clearTimeout(recoveryTimer);
    if (rated) sampleBacklog();
    frozen = {
      window: {
        bytes: bytes - windowBase.bytes,
        messages: messages - windowBase.messages,
        ms: round(now - windowStart),
      },
      metrics: metrics.stop(),
      pausedMs: round(pausedMs),
      pauses,
      handleMs: handle.summary(),
      gateWaitMs: slow || rated ? gateWait.summary() : undefined,
      transport: counters.stop(),
      consumer:
        rated && rateSpec
          ? {
              bytesPerSec: rateSpec.bytesPerSec,
              maxQueuedBytes: rated.maxQueuedBytes,
              maxQueuedFrames: rated.maxQueuedFrames,
              endQueuedBytes: rated.queuedBytes,
              endQueuedFrames: rated.queuedFrames,
              sampleMs: BACKLOG_SAMPLE_MS,
              series,
              recovery,
            }
          : undefined,
    };
  };

  const currentStats = (): PeerStats => ({
    pausedMs: 0,
    pauses: 0,
    handleMs: handle.summary(),
    ...frozen,
    consumed: { bytes, messages, lastSeq },
    reverse: reverse?.scheduler.stats(),
  });

  const onControl = (message: ControlMessage): void => {
    switch (message.t) {
      case "rpc":
        endpoint.send(padTo(caseSpec.rpc?.responseBytes ?? 0, { t: "rpcr", id: message.id }));
        return;
      case "barrier":
        post({ t: "barrierr", id: message.id, bytes, messages, lastSeq });
        return;
      case "measure":
        openWindow();
        return;
      case "stats":
        closeWindow();
        post({ t: "statsr", stats: currentStats() });
        return;
      default:
        return;
    }
  };

  const unsubscribe = endpoint.onMessage((data) => {
    if (isControl(data)) {
      const message = parseControl(data);
      if (message.t === "rev-ack") reverse?.scheduler.complete(message.seq);
      else if (message.t === "rpc") onControl(message);
      else if (rated) rated.pushControl(message);
      else if (queue.length > 0) {
        // Behind a pause: answered in order, once everything before it is consumed.
        queue.push(message);
        queuedAt.push(0);
      } else onControl(message);
      return undefined;
    }
    return onFrame(data);
  });

  if (caseSpec.reverse) {
    const spec = caseSpec.reverse;
    const payload = corpus(spec.frameBytes, seed ^ 0x5151, spec.kind);
    const scheduler = new Scheduler({
      ratePerSec: spec.ratePerSec,
      sampleEvery: SAMPLE_EVERY,
      frameBytes: spec.frameBytes + HEADER_BYTES,
      budget: config.sendBudget,
    });
    const deadline = performance.now() + config.warmupMs + config.measureMs + 5_000;
    void endpoint.ready().then(() =>
      scheduler.run((frame) => {
        const sample = frame.seq % SAMPLE_EVERY === 0;
        endpoint.send(encodeFrame(frame.seq, sample ? FLAG_SAMPLE : 0, payload));
      }, deadline),
    );
    reverse = { scheduler, stop: () => scheduler.stop() };
  }

  // The connection closed (a cancel, an overload close, teardown): close the window, drop what the
  // consumer holds, and report a second later what is left (after a forced GC).
  let stopped = false;
  let closeSeen = false;
  const unsubscribeClose = endpoint.onClose((info) => {
    if (closeSeen) return;
    closeSeen = true;
    const atEpochMs = Date.now();
    reverse?.stop();
    closeWindow();
    const memoryAtClose = snapshot();
    const droppedAtClose = rated ? rated.drop() : dropPaused();
    const stats = currentStats();
    const consumed = { bytes, messages, lastSeq };
    if (!report || stopped) return;
    // ArrayBuffer backing stores are freed by a background task after the collection that found
    // them dead, so the reading comes 200 ms after one forced GC and right after a second one.
    setTimeout(() => {
      forceGc();
      setTimeout(() => {
        const gcForced = forceGc();
        report({
          ...info,
          atEpochMs,
          consumed,
          droppedAtClose,
          memoryAtClose,
          memoryAfter: snapshot(),
          gcForced,
          stats,
        });
      }, 200);
    }, 1_000);
  });

  /** The pausing consumer's queue on a close: its frames are dropped, their handlers released. */
  function dropPaused(): { bytes: number; frames: number } {
    let droppedBytes = 0;
    let frames = 0;
    for (const item of queue) {
      if (item instanceof Uint8Array) {
        droppedBytes += item.byteLength - HEADER_BYTES;
        frames++;
      }
    }
    queue.length = 0;
    queuedAt.length = 0;
    const wake = resolveDrained;
    drained = undefined;
    resolveDrained = undefined;
    wake?.();
    return { bytes: droppedBytes, frames };
  }

  return {
    stop() {
      // A close already seen still sends its report; teardown after that is not a second close.
      if (!closeSeen) stopped = true;
      unsubscribe();
      unsubscribeClose();
      clearTimeout(windowTimer);
      clearInterval(sampler);
      clearTimeout(recoveryTimer);
      reverse?.stop();
    },
  };
}
