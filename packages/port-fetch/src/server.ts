import { AckCoalescer, BodyPump, BodyReceiver, FlowWindow, ReceiveBudget } from "./flow.ts";
import { ackCoalesce as parseAckCoalesce, type AckCoalesceOptions, chunkBytes, positiveInteger } from "./options.ts";
import type { Port } from "./ports.ts";
import {
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_MAX_QUEUED_BYTES,
  DEFAULT_WINDOW_BYTES,
  errorFrame,
  parsePortMessage,
  type PortErrorCode,
  type PortMessage,
  type RequestHeadMessage,
} from "./protocol.ts";
import { Counters, type PortStats } from "./stats.ts";

export interface ServePortOptions {
  /**
   * Unacknowledged response-body bytes in flight per request. Defaults to 1 MiB. Keep it at most
   * the client's `maxQueuedBytes`, or a slowly read response fails as a flow-control violation.
   */
  windowBytes?: number;
  /** Largest response-body chunk sent in one frame; at most `windowBytes`, which is the default. */
  maxChunkBytes?: number;
  /**
   * Requests served at once; a head beyond it is answered with an `error` of code `"busy"` without
   * calling `fetch`. Defaults to 256.
   */
  maxConcurrentRequests?: number;
  /**
   * Request-body bytes received but not yet read by handlers, across all requests, before readers
   * with a backlog hold back their acks. Also the most one upload may queue unread: beyond it the
   * client is ignoring flow control and the request fails. Defaults to 8 MiB. An upload is dropped
   * once its response completes, so the backlog belongs to requests in flight: at most
   * `maxConcurrentRequests` times the client's `windowBytes`.
   */
  maxQueuedBytes?: number;
  /** Coalesce request-body acks; by default each chunk is acked as soon as the handler reads it. */
  ackCoalesce?: AckCoalesceOptions;
}

export interface PortServer {
  /**
   * Aborts every in-flight request, telling the client with an `error` of code `"closed"`, and
   * stops listening. The port itself is left to its owner.
   */
  close(): void;
  /** Counters for this side of the connection. */
  stats(): PortStats;
}

interface InFlight {
  controller: AbortController;
  /** Whether the head announced a body; chunks for a request without one break the protocol. */
  hasBody: boolean;
  /** Set once `request-end` arrived. */
  bodyEnded: boolean;
  /** The request body this side receives, when there is one. */
  receiver?: BodyReceiver;
  /** Sends the response body, once there is one. */
  pump?: BodyPump;
  /** Flow control for the response body this side sends. */
  window: FlowWindow;
  cancelled: boolean;
}

/** A failure while serving a request, with the code the client gets. */
class ServeError extends Error {
  readonly code: PortErrorCode;
  constructor(message: string, code: PortErrorCode) {
    super(message);
    this.code = code;
  }
}

/** Wraps whatever `step` throws as a `ServeError` of `code`, keeping the original name and message. */
async function attempt<T>(code: PortErrorCode, step: () => T | Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    if (err instanceof ServeError) throw err;
    throw coded(err, code);
  }
}

function coded(err: unknown, code: PortErrorCode): ServeError {
  const wrapped = new ServeError(err instanceof Error ? err.message : String(err), code);
  if (err instanceof Error) wrapped.name = err.name;
  return wrapped;
}

/**
 * Serves requests arriving on `port` with `fetch`, a `(Request) => Response` such as a Hono app's,
 * streaming each response back. A `cancel` from the client, a failed request body, the port
 * closing and `close()` all abort the request's `signal` and stop its response body; a `fetch`
 * that throws, a response the port cannot carry, a frame that breaks the protocol, or any other
 * failure while serving a request is reported as an `error` message with a `code` (before or after
 * the response head), never left hanging. A response that is complete ends the request: an upload
 * the handler is still reading settles with `done`. Nothing escapes the port's message handler or
 * a request's own handling.
 */
export function servePort(
  port: Port,
  fetch: (request: Request) => Response | Promise<Response>,
  options: ServePortOptions = {},
): PortServer {
  // Nonsense options throw here, not on the first request.
  const windowBytes = positiveInteger("windowBytes", options.windowBytes, DEFAULT_WINDOW_BYTES);
  const maxChunkBytes = chunkBytes(options.maxChunkBytes, windowBytes);
  const maxConcurrentRequests = positiveInteger(
    "maxConcurrentRequests",
    options.maxConcurrentRequests,
    DEFAULT_MAX_CONCURRENT_REQUESTS,
  );
  const maxQueuedBytes = positiveInteger("maxQueuedBytes", options.maxQueuedBytes, DEFAULT_MAX_QUEUED_BYTES);
  const ackCoalesce = parseAckCoalesce(options.ackCoalesce);
  // One coalescing timer for the whole connection, not one per body.
  const coalesce = ackCoalesce && new AckCoalescer(ackCoalesce);

  const inFlight = new Map<number, InFlight>();
  const counters = new Counters();
  const budget = new ReceiveBudget(maxQueuedBytes, counters);

  /** Posts and counts `message`; throws if the port does. */
  const send = (message: PortMessage) => {
    port.postMessage(message);
    counters.countSent(message);
  };

  const post = (message: PortMessage) => {
    try {
      send(message);
    } catch {
      // The port is gone; its close event aborts what is in flight.
    }
  };

  /** Ends `entry`: aborts the request, stops its body streams, releases its window. Idempotent. */
  const abort = (id: number, entry: InFlight, reason: unknown) => {
    if (entry.cancelled) return;
    entry.cancelled = true;
    entry.pump?.cancel(reason);
    entry.window.release();
    entry.controller.abort(reason);
    entry.receiver?.error(reason);
    inFlight.delete(id);
  };

  /**
   * Ends `entry` after its response was fully sent. The request is over, so an upload the handler
   * is still reading settles with `done` instead of waiting for chunks the client stopped sending.
   */
  const complete = (id: number, entry: InFlight) => {
    if (entry.cancelled) return;
    entry.cancelled = true;
    entry.window.release();
    entry.receiver?.finish();
    inFlight.delete(id);
  };

  /** Reports a failure to the client (before or after the head) and ends `entry`. */
  const fail = (id: number, entry: InFlight, err: unknown, code: PortErrorCode) => {
    if (entry.cancelled) return;
    post(errorFrame(id, err, code));
    abort(id, entry, err);
  };

  /** The client broke the protocol for this request: tell it, and abort the request here. */
  const protocolError = (id: number, entry: InFlight | undefined, reason: string) => {
    counters.protocolErrors++;
    const err = new ServeError(reason, "protocol");
    err.name = "ProtocolError";
    if (entry) fail(id, entry, err, "protocol");
    else post(errorFrame(id, err, "protocol"));
  };

  const handle = async (head: RequestHeadMessage, entry: InFlight) => {
    try {
      await serve(head, entry);
    } catch (err) {
      // Whatever failed, wherever: the client learns of it and the request is cleaned up.
      fail(head.id, entry, err, err instanceof ServeError ? err.code : "fetch-failed");
    }
  };

  const serve = async (head: RequestHeadMessage, entry: InFlight) => {
    const { id } = head;
    // GET and HEAD requests cannot carry a body; drop and acknowledge one if a client sends it.
    const bodyAllowed = head.hasBody && head.method !== "GET" && head.method !== "HEAD";
    if (bodyAllowed) {
      entry.receiver = new BodyReceiver({
        ack: (bytes) => post({ type: "ack", id, bytes }),
        onCancel: () => {},
        onOverflow: () => protocolError(id, entry, `The request body queued more than ${maxQueuedBytes} unread bytes`),
        budget,
        counters,
        coalesce,
      });
    }

    const response = await attempt("fetch-failed", () => {
      const body = entry.receiver?.stream ?? null;
      const request = new Request(head.url, {
        method: head.method,
        headers: head.headers,
        body,
        signal: entry.controller.signal,
        // A streamed body needs `duplex`; spread so the DOM lib's RequestInit type accepts it too.
        ...(body ? { duplex: "half" } : {}),
      });
      return fetch(request);
    });
    if (entry.cancelled) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    // A Response the client could not rebuild (`Response.error()` has status 0) is an error, not a
    // head that crashes the client's handler. So is a body someone else is already reading.
    if (!(response.status >= 200 && response.status <= 599)) {
      await response.body?.cancel().catch(() => {});
      throw new ServeError(`The response status ${response.status} cannot be sent over the port`, "invalid-status");
    }
    if (response.body?.locked) throw new ServeError("The response body is locked by another reader", "body-failed");

    // Attach to the body before the head goes out, so nothing can fail between the two.
    entry.pump = response.body
      ? new BodyPump(
          response.body,
          (chunk): PortMessage => ({ type: "response-chunk", id, chunk }),
          (): PortMessage => ({ type: "response-end", id }),
          send,
          entry.window,
          maxChunkBytes,
        )
      : undefined;
    post({
      type: "response",
      id,
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers],
      hasBody: entry.pump !== undefined,
    });
    // A failing body rejects here and is reported after the head; the client errors its stream.
    const pump = entry.pump;
    if (pump) await attempt("body-failed", () => pump.done);
    complete(id, entry);
  };

  const start = (head: RequestHeadMessage) => {
    const { id } = head;
    const existing = inFlight.get(id);
    if (existing) {
      protocolError(id, existing, `A request with id ${id} is already in flight`);
      return;
    }
    if (inFlight.size >= maxConcurrentRequests) {
      counters.busyRejections++;
      post(
        errorFrame(id, new ServeError(`${maxConcurrentRequests} requests are already being served`, "busy"), "busy"),
      );
      return;
    }
    const entry: InFlight = {
      controller: new AbortController(),
      hasBody: head.hasBody,
      bodyEnded: false,
      window: new FlowWindow(windowBytes, counters),
      cancelled: false,
    };
    inFlight.set(id, entry);
    void handle(head, entry);
  };

  const onMessage = (message: PortMessage) => {
    if (message.type === "request") {
      start(message);
      return;
    }
    // A request that already ended (or was refused) ignores late frames: normal races, not violations.
    const { id } = message;
    const entry = inFlight.get(id);
    if (!entry) return;
    switch (message.type) {
      case "request-chunk":
        if (!entry.hasBody || entry.bodyEnded) {
          protocolError(
            id,
            entry,
            entry.hasBody
              ? "A request body chunk arrived after its end"
              : "A body chunk arrived for a request without one",
          );
          return;
        }
        if (entry.receiver) entry.receiver.push(message.chunk);
        else post({ type: "ack", id, bytes: message.chunk.byteLength });
        return;
      case "request-end":
        if (!entry.hasBody || entry.bodyEnded) {
          protocolError(
            id,
            entry,
            entry.hasBody ? "The request body ended twice" : "A body end arrived for a request without one",
          );
          return;
        }
        entry.bodyEnded = true;
        entry.receiver?.end();
        return;
      case "ack":
        entry.window.ack(message.bytes);
        return;
      case "cancel":
        abort(id, entry, new DOMException(message.reason ?? "The client cancelled the request", "AbortError"));
        return;
      case "error":
        // The client's request body failed: the handler cannot get the rest, so abort the request.
        abort(id, entry, new Error(message.message));
        return;
      default:
        return;
    }
  };

  const unsubscribeMessage = port.onMessage((value) => {
    const parsed = parsePortMessage(value, "server");
    if (!parsed) {
      counters.ignoredFrames++;
      return;
    }
    if (!parsed.ok) {
      counters.invalidFrames++;
      // A malformed head gets an answer so the client does not wait; other frames only matter for a live request.
      const entry = inFlight.get(parsed.id);
      if (entry || (typeof value === "object" && value !== null && "type" in value && value.type === "request")) {
        protocolError(parsed.id, entry, parsed.reason);
      }
      return;
    }
    const { message } = parsed;
    counters.countReceived(message);
    try {
      onMessage(message);
    } catch (err) {
      // Nothing may escape a port handler: a frame that cannot be handled ends its request, not the process.
      const entry = inFlight.get(message.id);
      if (entry) fail(message.id, entry, err, "protocol");
    }
  });

  const closeAll = (reason: unknown, notify: boolean) => {
    for (const [id, entry] of inFlight) {
      if (notify) post(errorFrame(id, reason, "closed"));
      abort(id, entry, reason);
    }
  };
  const unsubscribeClose = port.onClose(() => closeAll(new Error("The port closed"), false));
  port.start?.();

  return {
    close() {
      closeAll(new Error("The server closed"), true);
      unsubscribeMessage();
      unsubscribeClose();
    },
    stats: () => counters.snapshot(inFlight.size),
  };
}
