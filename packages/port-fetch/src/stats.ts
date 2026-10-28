import type { PortMessage, PortMessageType } from "./protocol.ts";

/**
 * Counters for one side of a connection, read with `stats()`. They are plain integers bumped
 * inline; nothing is computed or allocated until `stats()` takes a snapshot.
 */
export interface PortStats {
  /** Frames this side posted, per type. */
  framesSent: Record<PortMessageType, number>;
  /** Valid frames this side received, per type (late ones for finished requests included). */
  framesReceived: Record<PortMessageType, number>;
  /** Messages that were not frames of ours (not an object, unknown type, unusable id): ignored. */
  ignoredFrames: number;
  /** Frames of ours that were malformed or travelled the wrong way (they fail their request if it is live). */
  invalidFrames: number;
  /** Requests this side ended because the peer broke the protocol (invalid frame, bad state, version). */
  protocolErrors: number;
  /** Body bytes posted in chunk frames. */
  bodyBytesSent: number;
  /** Body bytes received in chunk frames. */
  bodyBytesReceived: number;
  /** Consumptions that did not get an ack of their own because `ackCoalesce` folded them into another. */
  acksCoalesced: number;
  /** Acks for more bytes than were outstanding; the excess was ignored. */
  acksClamped: number;
  /** Times the `maxQueuedBytes` budget held back an ack (the sender waits until the queue drains). */
  acksWithheld: number;
  /** Time body senders on this side spent waiting for credit, in milliseconds. */
  creditWaitMs: number;
  /** Body bytes received and not yet consumed, across requests. */
  queuedBytes: number;
  /** The highest `queuedBytes` seen. */
  peakQueuedBytes: number;
  /** Requests in flight now. */
  activeRequests: number;
  /** Requests refused for `maxConcurrentRequests`, or on the client for finished responses over `maxQueuedBytes` unread. */
  busyRejections: number;
}

type Counted = Omit<PortStats, "framesSent" | "framesReceived" | "activeRequests">;

export class Counters implements Counted {
  readonly sent = byType();
  readonly received = byType();
  ignoredFrames = 0;
  invalidFrames = 0;
  protocolErrors = 0;
  bodyBytesSent = 0;
  bodyBytesReceived = 0;
  acksCoalesced = 0;
  acksClamped = 0;
  acksWithheld = 0;
  creditWaitMs = 0;
  queuedBytes = 0;
  peakQueuedBytes = 0;
  busyRejections = 0;

  countSent(message: PortMessage): void {
    this.sent[message.type]++;
    if (message.type === "request-chunk" || message.type === "response-chunk") {
      this.bodyBytesSent += message.chunk.byteLength;
    }
  }

  countReceived(message: PortMessage): void {
    this.received[message.type]++;
    if (message.type === "request-chunk" || message.type === "response-chunk") {
      this.bodyBytesReceived += message.chunk.byteLength;
    }
  }

  snapshot(activeRequests: number): PortStats {
    return {
      framesSent: { ...this.sent },
      framesReceived: { ...this.received },
      ignoredFrames: this.ignoredFrames,
      invalidFrames: this.invalidFrames,
      protocolErrors: this.protocolErrors,
      bodyBytesSent: this.bodyBytesSent,
      bodyBytesReceived: this.bodyBytesReceived,
      acksCoalesced: this.acksCoalesced,
      acksClamped: this.acksClamped,
      acksWithheld: this.acksWithheld,
      creditWaitMs: Math.round(this.creditWaitMs * 1000) / 1000,
      queuedBytes: this.queuedBytes,
      peakQueuedBytes: this.peakQueuedBytes,
      activeRequests,
      busyRejections: this.busyRejections,
    };
  }
}

function byType(): Record<PortMessageType, number> {
  return {
    request: 0,
    "request-chunk": 0,
    "request-end": 0,
    response: 0,
    "response-chunk": 0,
    "response-end": 0,
    ack: 0,
    cancel: 0,
    error: 0,
  };
}
