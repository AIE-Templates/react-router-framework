/** The port closed while requests were pending or streaming, or was already closed when one started. */
export class PortClosedError extends Error {
  override name = "PortClosedError";
  constructor(message = "The port closed before the request completed") {
    super(message);
  }
}

/**
 * Which client budget refused a fetch: `requests`, `maxConcurrentRequests` in flight; `unread`, more
 * than `maxQueuedBytes` of responses that already ended are queued unread.
 */
export type PortBusyBudget = "requests" | "unread";

/**
 * The client refused the fetch and sent nothing: it already had `maxConcurrentRequests` in flight,
 * or more than `maxQueuedBytes` of finished responses nobody has read or cancelled (`budget` says which).
 */
export class PortBusyError extends Error {
  override name = "PortBusyError";
  readonly budget: PortBusyBudget;
  readonly maxConcurrentRequests: number;
  constructor(maxConcurrentRequests: number, budget: PortBusyBudget = "requests", maxQueuedBytes?: number) {
    super(
      budget === "requests"
        ? `${maxConcurrentRequests} requests are already in flight on this port`
        : `More than ${maxQueuedBytes} bytes of finished responses are unread on this port`,
    );
    this.budget = budget;
    this.maxConcurrentRequests = maxConcurrentRequests;
  }
}

export interface RemoteFetchErrorOptions {
  /** The `error` frame's `code` (see `PortErrorCode`), or `"protocol"` for a malformed frame the client got. */
  code?: string;
  /** The remote error's `name`, for diagnostics; no class or stack crosses the port. */
  remoteName?: string;
}

/**
 * The serving side reported a failure (its `fetch` threw, it could not build the request, it was
 * busy, ...), or what it sent broke the protocol. `message` is the remote message, `code` the
 * machine-readable reason when there is one (`PortErrorCode`), `remoteName` the remote error's name.
 */
export class RemoteFetchError extends Error {
  override name = "RemoteFetchError";
  readonly code: string | undefined;
  readonly remoteName: string | undefined;
  constructor(message: string, { code, remoteName }: RemoteFetchErrorOptions = {}) {
    super(message);
    this.code = code;
    this.remoteName = remoteName;
  }
}

/** Which bound a timed-out request exceeded; see `PortFetchOptions`. */
export type TimeoutPhase = "headers" | "idle" | "total";

/** The request exceeded one of its time bounds; both sides have been cleaned up. */
export class PortFetchTimeoutError extends Error {
  override name = "TimeoutError";
  readonly phase: TimeoutPhase;
  constructor(timeoutMs: number, phase: TimeoutPhase = "total") {
    super(
      phase === "headers"
        ? `The response headers did not arrive within ${timeoutMs} ms`
        : phase === "idle"
          ? `No response body data arrived for ${timeoutMs} ms`
          : `The request did not complete within ${timeoutMs} ms`,
    );
    this.phase = phase;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
