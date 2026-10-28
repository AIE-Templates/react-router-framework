import { round } from "./histogram.ts";
import type { MemorySample } from "./metrics.ts";
import type { PeerStats } from "./peer.ts";

/**
 * Backlog measurements for the `consumer` cases (a consumer slower than its producer): sampled
 * series on each side's own clock, their summaries, and what the peer reports when the connection
 * closes (a cancel, or a close it did not choose).
 */

/** How often both sides sample their backlog and memory during the measure window. */
export const BACKLOG_SAMPLE_MS = 200;

/** The peer's queue of received, unconsumed frames and its memory, at `t` ms into its window. */
export interface PeerSample {
  t: number;
  queuedBytes: number;
  queuedFrames: number;
  /** Payload bytes consumed since the window opened. */
  consumedBytes: number;
  heapUsed: number;
  rss: number;
  arrayBuffers: number;
}

/** The peer's consumer over its measure window. */
export interface PeerConsumerStats {
  bytesPerSec: number;
  maxQueuedBytes: number;
  maxQueuedFrames: number;
  /** Queued when the window closed. */
  endQueuedBytes: number;
  endQueuedFrames: number;
  sampleMs: number;
  series: PeerSample[];
  /** `recoverAtFraction` cases: the moment the consumer recovered (ms into the window) and how its queue went. */
  recovery?: {
    atMs: number;
    queuedAtRecovery: { bytes: number; frames: number };
    /** From recovery until the queue was first empty; `null` if it never emptied inside the window. */
    queueEmptyAfterMs: number | null;
  };
}

/** The sender's view at `t` ms into its window, in frames of the stream's timetable. */
export interface SenderSample {
  t: number;
  /** Frames the timetable had due by now. */
  dueFrames: number;
  /** Frames handed to the transport. */
  sentFrames: number;
  /** Frames the peer acknowledged as consumed (every frame is acknowledged in these cases). */
  consumedFrames: number;
  /** Package: the channel's `bufferedAmount`; raw: unacknowledged credit bytes. */
  bufferedBytes: number;
  heapUsed: number;
  rss: number;
}

/**
 * The backlog over the sender's window. End to end is due but not consumed (behind the timetable at
 * the sender, in flight, or queued at the peer); in flight is sent but not consumed. Bytes are
 * payload bytes (frames × frame size).
 */
export interface SenderBacklog {
  sampleMs: number;
  series: SenderSample[];
  maxEndToEndBytes: number;
  endEndToEndBytes: number;
  maxInFlightBytes: number;
  endInFlightBytes: number;
  /** Frames due before the deadline that the sender never sent (it stops at the deadline). */
  abandonedFrames: number;
  /** `recoverAtFraction` cases, on the sender's clock. */
  recovery?: SenderRecovery;
}

export interface SenderRecovery {
  /** The recovery moment, ms into the sender's window (the peer's comes a control trip earlier). */
  startMs: number;
  endToEndAtStartBytes: number;
  /**
   * From recovery until the end-to-end backlog was first down to `clearedBelowFrames` (exact, at the
   * acknowledgement that brought it there); `null` if it never was inside the window.
   */
  clearedAfterMs: number | null;
  clearedBelowFrames: number;
  /** Consumption rate from that moment to the end of the window, against the producer's rate. */
  consumedBytesPerSecAfter: number | null;
  producerBytesPerSec: number;
}

/** What the peer saw when its connection closed, sent over the link's side channel, not the endpoint. */
export interface PeerCloseReport {
  code?: number;
  reason?: string;
  error?: string;
  /** `Date.now()` when the peer saw the close, comparable with the sender's on one machine. */
  atEpochMs: number;
  /** Running totals at the close (`lastSeq` of the measure window's frames once it has started). */
  consumed: { bytes: number; messages: number; lastSeq: number };
  /** Frames received but not consumed at the close, which the consumer then dropped. */
  droppedAtClose: { bytes: number; frames: number };
  memoryAtClose: MemorySample;
  /** 1.2 s after the close, the queue dropped, after forced full GCs (if available; see `gcForced`). */
  memoryAfter: MemorySample;
  gcForced: boolean;
  /** The peer's window stats (frozen when it closed, or at the close if it was still open). */
  stats: PeerStats;
}

/** What the sender derives from its cancel and the peer's close report. */
export interface CancelRelease {
  /** From the sender's `close()` until the peer saw the close (two processes' wall clocks, ms). */
  peerSawCloseAfterMs: number;
  /**
   * Frames the peer consumed after the sender's cancel (it was still working through the backlog).
   * Only with every frame acknowledged (`ackEvery: 1`): otherwise the sender's count lags by up to
   * `ackEvery - 1` frames and this would mostly measure that.
   */
  consumedAfterCancel?: number;
  /** Frames the peer had received but not consumed at the close, dropped then. */
  droppedAtPeer: number;
  /** Frames sent that the peer never received: dropped in the transport by the close. */
  neverDelivered: number;
  /** Peer memory at the close and 1.2 s later (after forced GCs). */
  peerArrayBuffersAtClose: number;
  peerArrayBuffersAfter: number;
  peerHeapUsedAtClose: number;
  peerHeapUsedAfter: number;
}

export function summarizeSenderBacklog(
  series: SenderSample[],
  frameBytes: number,
  abandonedFrames: number,
  recovery?: Omit<SenderRecovery, "endToEndAtStartBytes"> & { endToEndAtStartFrames: number },
): SenderBacklog {
  let maxEndToEnd = 0;
  let maxInFlight = 0;
  for (const s of series) {
    maxEndToEnd = Math.max(maxEndToEnd, s.dueFrames - s.consumedFrames);
    maxInFlight = Math.max(maxInFlight, s.sentFrames - s.consumedFrames);
  }
  const last = series.at(-1);
  const out: SenderBacklog = {
    sampleMs: BACKLOG_SAMPLE_MS,
    series,
    maxEndToEndBytes: maxEndToEnd * frameBytes,
    endEndToEndBytes: last ? Math.max(0, last.dueFrames - last.consumedFrames) * frameBytes : 0,
    maxInFlightBytes: maxInFlight * frameBytes,
    endInFlightBytes: last ? Math.max(0, last.sentFrames - last.consumedFrames) * frameBytes : 0,
    abandonedFrames,
  };
  if (recovery) {
    const { endToEndAtStartFrames, ...rest } = recovery;
    out.recovery = { ...rest, endToEndAtStartBytes: endToEndAtStartFrames * frameBytes };
  }
  return out;
}

export function cancelRelease(
  cancel: { atEpochMs: number; framesBeforeCancel: number; consumedBeforeCancel: number },
  report: PeerCloseReport,
  exactAcks: boolean,
): CancelRelease {
  const consumedByPeer = report.consumed.lastSeq + 1;
  return {
    peerSawCloseAfterMs: round(report.atEpochMs - cancel.atEpochMs),
    consumedAfterCancel: exactAcks ? Math.max(0, consumedByPeer - cancel.consumedBeforeCancel) : undefined,
    droppedAtPeer: report.droppedAtClose.frames,
    neverDelivered: Math.max(0, cancel.framesBeforeCancel - consumedByPeer - report.droppedAtClose.frames),
    peerArrayBuffersAtClose: report.memoryAtClose.arrayBuffers,
    peerArrayBuffersAfter: report.memoryAfter.arrayBuffers,
    peerHeapUsedAtClose: report.memoryAtClose.heapUsed,
    peerHeapUsedAfter: report.memoryAfter.heapUsed,
  };
}
