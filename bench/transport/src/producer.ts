import {
  BACKLOG_SAMPLE_MS,
  type CancelRelease,
  type PeerCloseReport,
  type SenderBacklog,
  type SenderSample,
  summarizeSenderBacklog,
} from "./backlog.ts";
import type { RunConfig } from "./config.ts";
import type { CloseInfo, Endpoint } from "./endpoint.ts";
import { expect, isPeerStats } from "./guards.ts";
import { round } from "./histogram.ts";
import type { PeerStats } from "./peer.ts";
import {
  type ControlOut,
  encodeFrame,
  FLAG_SAMPLE,
  HEADER_BYTES,
  isControl,
  padTo,
  parseControl,
  SAMPLE_EVERY,
} from "./protocol.ts";
import { Scheduler, type SchedulerStats, sleep } from "./scheduler.ts";
import { corpus, type StreamSpec } from "./workload.ts";

/**
 * The sending side of a stream case. Frames go out on the case's timetable; every 16th (or every
 * `ackEvery`-th) carries the sample flag and the peer acknowledges it, which completes that frame
 * on this side's clock. The raw variant keeps at most `windowBytes` unacknowledged by waiting for
 * the peer's credits; the package variant waits on the channel's own `whenDrained()`.
 *
 * The measure window is `measureMs` long on each side's own clock: on the sender it runs from
 * `measureStart` to the end of submission (`measureEnd`, the hooks), on the peer from the `measure`
 * message for `measureMs`. Goodput is what the peer consumed inside its window; what was still in
 * flight when it closed is drained afterwards and reported separately (`drain`), never added to it.
 *
 * A close this side did not ask for (the peer's overload close `4008`, a transport failure) stops
 * every send loop and ends the run with `closed` set, in whatever phase it came; nothing waits for a
 * reply on the closed connection.
 */
export interface StreamResult {
  stream?: SchedulerStats;
  rpc?: SchedulerStats;
  /**
   * Payload bytes and frames the peer consumed inside its measure window, over that window's length
   * on the peer's clock. With a cancel or a close, the count comes from the acknowledgements on the
   * sender's clock (no barrier on a closed channel; up to `ackEvery - 1` frames short), over the
   * sender's window, unless the peer's close report brought its own window (then that, as usual).
   */
  goodput: { bytes: number; messages: number; bytesPerSec: number; messagesPerSec: number; measureMs: number };
  /**
   * Everything submitted in the window, consumed to the end: `submissionMs` from the window start to
   * the last send, `drainMs` from there until the peer confirmed (barrier) that it consumed it all,
   * one control round trip included; `bytesPerSec` is `bytes` over the sum. `inFlightAtEnd` is
   * what the peer consumed after its window closed (submitted in the window, not yet consumed).
   * Absent with a cancel or a close.
   */
  drain?: {
    bytes: number;
    messages: number;
    bytesPerSec: number;
    submissionMs: number;
    drainMs: number;
    inFlightAtEnd: { bytes: number; messages: number };
  };
  /** Reverse frames (peer → sender) consumed here during the measure window. */
  reverseConsumed?: { bytes: number; messages: number };
  /**
   * `cancelAtFrame` or `cancelAtEnd`: the sender's `close()` and how long until its channel reported
   * closed; frames sent and acknowledged as consumed by then (measure-window sequence numbers), and
   * the wall-clock moment (`Date.now()`) for comparison with the peer's close report.
   */
  cancel?: { closeToClosedMs: number; framesBeforeCancel: number; consumedBeforeCancel?: number; atEpochMs?: number };
  /** A close the sender did not ask for: its code and reason, the phase, and when (ms since the run started). */
  closed?: CloseInfo & { phase: "warmup" | "measure" | "drain"; afterMs: number };
  /** `consumer` cases: the backlog over the sender's window. */
  backlog?: SenderBacklog;
  /** With a cancel or a close: what the peer reported over the link's side channel (run-one adds it). */
  peerClose?: PeerCloseReport;
  /** With a cancel and the peer's report: what happened to the backlog (run-one adds it). */
  release?: CancelRelease;
  /** Time the sender spent waiting for credit / drain (ms, summed over waits). */
  waitedForCreditMs: number;
  peer: PeerStats;
}

/**
 * Called when the sender's measure window starts and when it ends (the last frame submitted, before
 * the drain), for the sender's process metrics and counters.
 */
export interface MeasureHooks {
  measureStart?(): void;
  measureEnd?(): void;
}

export async function runProducer(
  endpoint: Endpoint,
  config: RunConfig,
  hooks: MeasureHooks = {},
): Promise<StreamResult> {
  const { caseSpec, variant, windowBytes, seed } = config;
  const spec = caseSpec.stream;
  if (!spec) throw new Error(`case ${caseSpec.name} has no stream`);
  const ackEvery = caseSpec.ackEvery ?? SAMPLE_EVERY;
  const stopAtDeadline = caseSpec.consumer !== undefined;
  const runStart = performance.now();
  await endpoint.ready();

  // Credit window for the raw variant: the peer returns bytes as it consumes them.
  let outstanding = 0;
  let waiters: (() => void)[] = [];
  let waitedMs = 0;
  const release = () => {
    const w = waiters;
    waiters = [];
    for (const wake of w) wake();
  };

  // Closes: one the sender asked for (`cancelling`) or one it did not (`remoteClose`).
  let phase: "warmup" | "measure" | "drain" = "warmup";
  let isClosed = false;
  let cancelling = false;
  let remoteClose: StreamResult["closed"];
  const schedulers: Scheduler[] = [];
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  endpoint.onClose((info) => {
    if (isClosed) return;
    isClosed = true;
    if (!cancelling) {
      remoteClose = { ...info, phase, afterMs: round(performance.now() - runStart) };
      // What was in flight will never be acknowledged: censored at the close, not left out.
      const now = performance.now();
      for (const scheduler of schedulers) scheduler.censor(now);
    }
    for (const scheduler of schedulers) scheduler.stop();
    release();
    resolveClosed?.();
  });
  /** `promise`, or `undefined` once the connection closed. */
  const unlessClosed = <T>(promise: Promise<T>): Promise<T | undefined> =>
    isClosed ? Promise.resolve(undefined) : Promise.race([promise, closed.then(() => undefined)]);

  const waitForCredit = async (bytes: number) => {
    const start = performance.now();
    for (;;) {
      if (isClosed || !(outstanding + bytes > windowBytes && outstanding > 0)) break;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    outstanding += bytes;
    waitedMs += performance.now() - start;
  };
  const waitForDrain = async () => {
    const start = performance.now();
    // A channel's `whenDrained()` resolves on close, so no race with `closed` here: one per wait
    // would pile handlers onto a promise that stays pending until teardown.
    await endpoint.whenDrained?.();
    waitedMs += performance.now() - start;
  };
  /** Admission: nothing (no allocation) when the frame fits, a promise when it has to wait. */
  const reserve = (bytes: number): Promise<void> | undefined => {
    if (variant === "raw") {
      if (outstanding + bytes > windowBytes && outstanding > 0) return waitForCredit(bytes);
      outstanding += bytes;
      return undefined;
    }
    if (endpoint.whenDrained && (endpoint.bufferedAmount ?? 0) + bytes > windowBytes) {
      return waitForDrain();
    }
    return undefined;
  };

  const pendingBarriers = new Map<number, (r: { bytes: number; messages: number; lastSeq: number }) => void>();
  let statsResolve: ((s: PeerStats) => void) | undefined;
  let reverseBytes = 0;
  let reverseMessages = 0;
  const stream = new Scheduler({
    ratePerSec: spec.ratePerSec,
    maxFrames: maxFrames(spec, caseSpec.cancelAtFrame),
    sampleEvery: ackEvery,
    frameBytes: spec.frameBytes + HEADER_BYTES,
    budget: config.sendBudget,
    stopAtDeadline,
  });
  const rpc = caseSpec.rpc
    ? new Scheduler({
        ratePerSec: caseSpec.rpc.ratePerSec,
        frameBytes: caseSpec.rpc.requestBytes,
        budget: config.sendBudget,
        stopAtDeadline,
      })
    : undefined;
  schedulers.push(stream);
  if (rpc) schedulers.push(rpc);

  // Recovery (`recoverAtFraction`): the end-to-end backlog is checked at every acknowledgement.
  const recoverAt = caseSpec.consumer?.recoverAtFraction;
  const interval = spec.ratePerSec > 0 ? 1000 / spec.ratePerSec : 0;
  const clearedBelowFrames = Math.ceil(spec.ratePerSec * 0.05) + 2;
  let recoveryStart = Number.POSITIVE_INFINITY;
  let clearedAt: number | undefined;
  let consumedAtClear = 0;
  const due = (now: number) =>
    interval > 0 && stream.startedAt > 0 ? Math.max(0, Math.floor((now - stream.startedAt) / interval) + 1) : 0;

  endpoint.onMessage((data) => {
    if (!isControl(data)) {
      reverseBytes += data.byteLength;
      reverseMessages++;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (view.getUint8(4) & FLAG_SAMPLE) endpoint.send(JSON.stringify({ t: "rev-ack", seq: view.getUint32(0, true) }));
      return;
    }
    const message = parseControl(data);
    switch (message.t) {
      case "ack":
        stream.complete(message.seq);
        lastAckedSeq = Math.max(lastAckedSeq, message.seq);
        if (clearedAt === undefined && phase === "measure") {
          const now = performance.now();
          if (now >= recoveryStart && due(now) - (lastAckedSeq + 1) <= clearedBelowFrames) {
            clearedAt = now;
            consumedAtClear = lastAckedSeq + 1;
          }
        }
        return;
      case "credit":
        outstanding = Math.max(0, outstanding - message.bytes);
        release();
        return;
      case "rpcr":
        rpc?.complete(message.id);
        return;
      case "barrierr":
        pendingBarriers.get(message.id)?.(message);
        pendingBarriers.delete(message.id);
        return;
      case "statsr":
        statsResolve?.(expect(message.stats, isPeerStats, "peer stats"));
        return;
      default:
        return;
    }
  });

  const post = (message: ControlOut) => endpoint.send(JSON.stringify(message));
  const barrier = (id: number) =>
    unlessClosed(
      new Promise<{ bytes: number; messages: number; lastSeq: number }>((resolve) => {
        pendingBarriers.set(id, resolve);
        post({ t: "barrier", id });
      }),
    );

  const payload = corpus(spec.frameBytes, seed, spec.kind);
  let framesSent = 0;
  let lastAckedSeq = -1;
  const frameBytes = payload.byteLength + HEADER_BYTES;
  const admitFrame = () => reserve(frameBytes);
  const sendFrame = (frame: { seq: number }) => {
    const sample = frame.seq % ackEvery === 0;
    endpoint.send(encodeFrame(frame.seq, sample ? FLAG_SAMPLE : 0, payload));
    framesSent++;
  };
  const sendRpc = (frame: { seq: number }) => {
    const request = caseSpec.rpc;
    if (!request) return;
    endpoint.send(padTo(request.requestBytes, { t: "rpc", id: frame.seq }));
  };

  // Warmup: the same traffic, nothing recorded as a result.
  const warmupDeadline = performance.now() + config.warmupMs;
  const warmup = new Scheduler({
    ratePerSec: spec.ratePerSec,
    maxFrames: spec.totalBytes ? Math.ceil(spec.totalBytes / spec.frameBytes) : undefined,
    frameBytes: spec.frameBytes + HEADER_BYTES,
    budget: config.sendBudget,
    stopAtDeadline,
  });
  schedulers.push(warmup);
  await warmup.run(sendFrame, warmupDeadline, admitFrame);
  await barrier(0);

  // The peer opens its window when it handles `measure`; the barrier makes sure it has before the
  // first measured frame goes out, and its totals are the base for the drain count.
  let before: { bytes: number; messages: number; lastSeq: number } | undefined;
  if (!remoteClose) {
    post({ t: "measure" });
    before = await barrier(1);
  }
  if (!before) {
    // Closed before the measure window: an empty window, so the run still reports sender metrics.
    hooks.measureStart?.();
    hooks.measureEnd?.();
    return {
      goodput: rates(0, 0, 1),
      closed: remoteClose,
      waitedForCreditMs: round(waitedMs),
      peer: emptyPeer({ bytes: 0, messages: 0, lastSeq: -1 }),
    };
  }
  phase = "measure";
  const reverseBefore = { bytes: reverseBytes, messages: reverseMessages };
  waitedMs = 0;
  framesSent = 0;
  lastAckedSeq = -1;
  hooks.measureStart?.();
  const measureStart = performance.now();
  const deadline = measureStart + config.measureMs;
  if (recoverAt !== undefined) recoveryStart = measureStart + recoverAt * config.measureMs;

  // The backlog series (`consumer` cases), sampled on this side's clock.
  const series: SenderSample[] = [];
  const sampleBacklog = () => {
    const now = performance.now();
    const m = process.memoryUsage();
    series.push({
      t: round(now - measureStart),
      dueFrames: due(Math.min(now, deadline)),
      sentFrames: framesSent,
      consumedFrames: lastAckedSeq + 1,
      bufferedBytes: variant === "raw" ? outstanding : (endpoint.bufferedAmount ?? 0),
      heapUsed: m.heapUsed,
      rss: m.rss,
    });
  };
  const sampler = caseSpec.consumer ? setInterval(sampleBacklog, BACKLOG_SAMPLE_MS) : undefined;

  let cancel: StreamResult["cancel"];
  const cancelNow = async (): Promise<void> => {
    stream.stop();
    rpc?.stop();
    if (isClosed) return;
    cancelling = true;
    const consumedBeforeCancel = lastAckedSeq + 1;
    // Frames and RPCs still waiting for their reply are censored at the cancel (see `censor`).
    const censorAt = performance.now();
    stream.censor(censorAt);
    rpc?.censor(censorAt);
    const atEpochMs = Date.now();
    const closeAt = performance.now();
    endpoint.close();
    await Promise.race([closed, sleep(5_000)]);
    cancel = {
      closeToClosedMs: round(performance.now() - closeAt),
      framesBeforeCancel: framesSent,
      consumedBeforeCancel,
      atEpochMs,
    };
  };
  const send = caseSpec.cancelAtFrame ? sendThenMaybeCancel : sendFrame;
  async function sendThenMaybeCancel(frame: { seq: number }): Promise<void> {
    sendFrame(frame);
    if (caseSpec.cancelAtFrame && framesSent >= caseSpec.cancelAtFrame) await cancelNow();
  }
  const streamRun = stream.run(send, deadline, admitFrame);
  const rpcRun = rpc?.run(sendRpc, deadline);
  await Promise.all([streamRun, rpcRun]);
  const measureEnd = performance.now();
  if (sampler) {
    clearInterval(sampler);
    sampleBacklog();
  }
  const consumedAtEnd = lastAckedSeq + 1;
  hooks.measureEnd?.();
  rpc?.stop();
  const reverseConsumed = caseSpec.reverse
    ? { bytes: reverseBytes - reverseBefore.bytes, messages: reverseMessages - reverseBefore.messages }
    : undefined;
  const submissionMs = measureEnd - measureStart;
  if (caseSpec.cancelAtEnd && !cancel) await cancelNow();
  if (phase === "measure") phase = "drain";

  const backlog = caseSpec.consumer
    ? summarizeSenderBacklog(
        series,
        spec.frameBytes,
        // Fixed when the stream loop ended; the latency stats are read after the drain, below.
        stream.abandoned,
        recoverAt === undefined
          ? undefined
          : {
              startMs: round(recoveryStart - measureStart),
              endToEndAtStartFrames: endToEndAt(series, recoveryStart - measureStart),
              clearedAfterMs: clearedAt === undefined ? null : round(clearedAt - recoveryStart),
              clearedBelowFrames,
              consumedBytesPerSecAfter:
                clearedAt === undefined || measureEnd - clearedAt < 1
                  ? null
                  : round((((consumedAtEnd - consumedAtClear) * spec.frameBytes) / (measureEnd - clearedAt)) * 1000, 0),
              producerBytesPerSec: spec.ratePerSec * spec.frameBytes,
            },
      )
    : undefined;

  let goodput: StreamResult["goodput"] | undefined;
  let drain: StreamResult["drain"];
  let peer = emptyPeer(before);
  if (!cancel && !remoteClose) {
    // The barrier is answered once the peer has consumed everything sent before it (sampled
    // acknowledgements and RPC responses travel ahead of its reply), so no settling sleep is needed.
    const after = await barrier(2);
    const drainMs = performance.now() - measureEnd;
    const stats = after
      ? await unlessClosed(
          new Promise<PeerStats>((resolve) => {
            statsResolve = resolve;
            post({ t: "stats" });
          }),
        )
      : undefined;
    if (after && stats) {
      peer = stats;
      const window = peer.window;
      if (!window) throw new Error("the peer reported no measure window");
      goodput = rates(window.bytes, window.messages, window.ms);
      const bytes = after.bytes - before.bytes;
      const messages = after.messages - before.messages;
      drain = {
        bytes,
        messages,
        bytesPerSec: round((bytes / (submissionMs + drainMs)) * 1000, 0),
        submissionMs: round(submissionMs),
        drainMs: round(drainMs),
        inFlightAtEnd: { bytes: bytes - window.bytes, messages: messages - window.messages },
      };
    }
  }
  if (!goodput) {
    // The endpoint is closed, so no barrier: count what the peer confirmed through the sampled
    // acknowledgements up to the end of the window (one in `ackEvery` frames, so up to
    // `ackEvery - 1` short) and leave the peer's metrics to its close report, if any.
    goodput = rates(consumedAtEnd * payload.byteLength, consumedAtEnd, submissionMs);
  }
  return {
    // After the drain, so acknowledgements that arrive while it runs still count.
    stream: stream.stats(),
    rpc: rpc?.stats(),
    goodput,
    drain,
    reverseConsumed,
    cancel,
    closed: remoteClose,
    backlog,
    waitedForCreditMs: round(waitedMs),
    peer,
  };
}

export function rates(bytes: number, messages: number, ms: number): StreamResult["goodput"] {
  return {
    bytes,
    messages,
    bytesPerSec: round((bytes / ms) * 1000, 0),
    messagesPerSec: round((messages / ms) * 1000, 0),
    measureMs: round(ms),
  };
}

/** Peer stats for a run whose peer never reported its own (only the running totals known here). */
function emptyPeer(consumed: { bytes: number; messages: number; lastSeq: number }): PeerStats {
  return {
    consumed,
    pausedMs: 0,
    pauses: 0,
    handleMs: { samples: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0 },
  };
}

/** Due minus consumed (frames) in the last sample at or before `t`. */
function endToEndAt(series: SenderSample[], t: number): number {
  let value = 0;
  for (const s of series) {
    if (s.t > t) break;
    value = Math.max(0, s.dueFrames - s.consumedFrames);
  }
  return value;
}

function maxFrames(spec: StreamSpec, cancelAtFrame: number | undefined): number | undefined {
  const byBytes = spec.totalBytes ? Math.ceil(spec.totalBytes / spec.frameBytes) : undefined;
  if (cancelAtFrame && byBytes) return Math.min(cancelAtFrame, byBytes);
  return cancelAtFrame ?? byBytes;
}
