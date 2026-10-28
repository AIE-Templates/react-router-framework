import {
  errorMessage,
  PortBusyError,
  PortClosedError,
  PortFetchTimeoutError,
  RemoteFetchError,
  type TimeoutPhase,
} from "./errors.ts";
import { AckCoalescer, BodyPump, BodyReceiver, FlowWindow, ReceiveBudget } from "./flow.ts";
import {
  ackCoalesce as parseAckCoalesce,
  type AckCoalesceOptions,
  chunkBytes,
  optionalTimeout,
  positiveInteger,
} from "./options.ts";
import type { Port } from "./ports.ts";
import {
  cap,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_MAX_QUEUED_BYTES,
  DEFAULT_WINDOW_BYTES,
  errorFrame,
  LIMITS,
  parsePortMessage,
  PROTOCOL_VERSION,
  type HeaderPairs,
  type PortMessage,
} from "./protocol.ts";
import { Counters, type PortStats } from "./stats.ts";

export interface PortFetchOptions {
  /**
   * Unacknowledged request-body bytes in flight per request. Defaults to 1 MiB. Keep it at most the
   * server's `maxQueuedBytes`, or a slowly read upload fails as a flow-control violation.
   */
  windowBytes?: number;
  /** Largest request-body chunk sent in one frame; at most `windowBytes`, which is the default. */
  maxChunkBytes?: number;
  /** Requests in flight at once; one more rejects at once with `PortBusyError`. Defaults to 256. */
  maxConcurrentRequests?: number;
  /**
   * Response-body bytes received but not yet read, across all requests, before readers with a
   * backlog hold back their acks. While responses that already ended hold more than this unread, a
   * fetch rejects at once with `PortBusyError` (`budget` `"unread"`) until they are read or
   * cancelled, so the unread backlog stays below `maxQueuedBytes` plus `maxConcurrentRequests` times
   * the server's `windowBytes`. Also the most one response may queue unread: beyond it the server
   * is ignoring flow control and the request fails. Defaults to 8 MiB.
   */
  maxQueuedBytes?: number;
  /** Coalesce response-body acks; by default each chunk is acked as soon as it is read. */
  ackCoalesce?: AckCoalesceOptions;
  /**
   * How long the response status and headers may take to arrive. Default: none. The bound for
   * requests whose cancellation cannot reach the server before it answers (Electron's `app://`).
   */
  headersTimeoutMs?: number;
  /** The longest gap allowed between two response body chunks. Default: none, so streams may idle. */
  idleTimeoutMs?: number;
  /** Upper bound for a whole request, headers to last body byte. Default: none. */
  timeoutMs?: number;
}

export type PortFetch = (request: Request) => Promise<Response>;

/** The `fetch` `createPortFetch()` returns, with counters for this side of the connection. */
export type PortFetchClient = PortFetch & { stats(): PortStats };

interface Pending {
  resolve: (response: Response) => void;
  reject: (err: unknown) => void;
  /** Set once the response head arrived; body messages go here. */
  receiver?: BodyReceiver;
  /** Sends the request body, when there is one. */
  pump?: BodyPump;
  /** Flow control for the request body this side sends. */
  window: FlowWindow;
  /** Set once the request is over, by completion or failure; nothing changes after that. */
  finished: boolean;
  /** Set once the promise was resolved with a response. */
  settled: boolean;
  timers: Map<TimeoutPhase, ReturnType<typeof setTimeout>>;
  detachSignal: () => void;
}

/**
 * A `fetch` that sends each request over `port` to a `servePort()` on the other side and streams
 * the response back. The returned `Response` resolves as soon as its status and headers arrive;
 * cancelling its body, or aborting the request's `signal`, tells the server to abort the request.
 *
 * Every way a request can end (completion, cancel, abort, a timeout, the port closing, the server
 * failing, the request body failing, the server breaking the protocol) goes through one termination path that stops the request
 * body pump, releases its flow window, clears timers and listeners and settles the promise or
 * errors the response body, exactly once.
 */
export function createPortFetch(port: Port, options: PortFetchOptions = {}): PortFetchClient {
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
  const headersTimeoutMs = optionalTimeout("headersTimeoutMs", options.headersTimeoutMs);
  const idleTimeoutMs = optionalTimeout("idleTimeoutMs", options.idleTimeoutMs);
  const timeoutMs = optionalTimeout("timeoutMs", options.timeoutMs);

  const pending = new Map<number, Pending>();
  const counters = new Counters();
  const budget = new ReceiveBudget(maxQueuedBytes, counters);
  let nextId = 1;
  let closed = false;

  /** Posts and counts `message`; throws if the port does. */
  const send = (message: PortMessage) => {
    port.postMessage(message);
    counters.countSent(message);
  };

  const post = (message: PortMessage) => {
    try {
      send(message);
    } catch {
      // The port is gone; the close handler (or the caller's own failure path) ends the request.
    }
  };

  /** Ends `entry` after its response was fully delivered: no failure, nothing more to do. */
  const complete = (id: number, entry: Pending) => {
    if (entry.finished) return;
    entry.finished = true;
    // The response is done, so the server no longer reads the request body (an early reply, e.g. a 413).
    entry.pump?.cancel();
    entry.window.release();
    // What is queued can still be read, but the server is done with this body: no more acks.
    entry.receiver?.stopAcks();
    for (const timer of entry.timers.values()) clearTimeout(timer);
    entry.detachSignal();
    pending.delete(id);
  };

  /** Ends `entry` with `err`: rejects the promise, or errors the response body once the head arrived. */
  const fail = (id: number, entry: Pending, err: unknown) => {
    if (entry.finished) return;
    complete(id, entry);
    if (entry.settled) entry.receiver?.error(err);
    else settle(entry).reject(err);
  };

  /**
   * Marks `entry` settled and hands out its resolving functions once, keeping no reference to them:
   * they hold the promise and so the `Response`, which a reader the caller kept must not keep alive.
   */
  const settle = (entry: Pending) => {
    const { resolve, reject } = entry;
    entry.settled = true;
    entry.resolve = entry.reject = noop;
    return { resolve, reject };
  };

  /** Fails `entry` and tells the server to abort the request. */
  const cancel = (id: number, entry: Pending, reason: unknown, err: unknown) => {
    if (entry.finished) return;
    post({ type: "cancel", id, reason: cap(errorMessage(reason), LIMITS.messageLength) });
    fail(id, entry, err);
  };

  /** The server broke the protocol for this request: cancel it there, reject or error it here. */
  const protocolError = (id: number, entry: Pending, reason: string) => {
    if (entry.finished) return;
    counters.protocolErrors++;
    cancel(id, entry, reason, new RemoteFetchError(reason, { code: "protocol" }));
  };

  const arm = (id: number, entry: Pending, phase: TimeoutPhase, ms: number | undefined) => {
    // A request that just ended (e.g. the chunk that re-arms `idle` overflowed it) keeps no timer.
    if (ms === undefined || entry.finished) return;
    const previous = entry.timers.get(phase);
    if (previous) clearTimeout(previous);
    const timeout = new PortFetchTimeoutError(ms, phase);
    entry.timers.set(
      phase,
      setTimeout(() => cancel(id, entry, timeout, timeout), ms),
    );
  };

  const disarm = (entry: Pending, phase: TimeoutPhase) => {
    const timer = entry.timers.get(phase);
    if (timer) clearTimeout(timer);
    entry.timers.delete(phase);
  };

  const onMessage = (message: PortMessage, entry: Pending) => {
    const { id } = message;
    switch (message.type) {
      case "response": {
        if (entry.settled) {
          protocolError(id, entry, "A second response head arrived for the request");
          return;
        }
        const receiver = new BodyReceiver({
          ack: (bytes) => post({ type: "ack", id, bytes }),
          onCancel: (reason) => cancel(id, entry, reason, reason),
          onOverflow: () =>
            protocolError(id, entry, `The response body queued more than ${maxQueuedBytes} unread bytes`),
          budget,
          counters,
          coalesce,
        });
        const headers = new Headers();
        for (const [name, value] of message.headers) headers.append(name, value);
        // Built before any state changes: a status the Response constructor rejects fails the request.
        const response = new Response(message.hasBody ? receiver.stream : null, {
          status: message.status,
          statusText: message.statusText,
          headers,
        });
        const { resolve } = settle(entry);
        entry.receiver = receiver;
        disarm(entry, "headers");
        if (message.hasBody) arm(id, entry, "idle", idleTimeoutMs);
        else complete(id, entry);
        resolve(response);
        return;
      }
      case "response-chunk":
        if (!entry.receiver) {
          protocolError(id, entry, "A response body chunk arrived before the response head");
          return;
        }
        entry.receiver.push(message.chunk);
        arm(id, entry, "idle", idleTimeoutMs);
        return;
      case "response-end":
        if (!entry.receiver) {
          protocolError(id, entry, "The response body ended before the response head");
          return;
        }
        entry.receiver.end();
        complete(id, entry);
        return;
      case "ack":
        entry.window.ack(message.bytes);
        return;
      case "error":
        fail(id, entry, new RemoteFetchError(message.message, { code: message.code, remoteName: message.name }));
        return;
      default:
        return;
    }
  };

  port.onMessage((value) => {
    const parsed = parsePortMessage(value, "client");
    if (!parsed) {
      counters.ignoredFrames++;
      return;
    }
    if (!parsed.ok) {
      counters.invalidFrames++;
      const entry = pending.get(parsed.id);
      if (entry) protocolError(parsed.id, entry, parsed.reason);
      return;
    }
    const { message } = parsed;
    counters.countReceived(message);
    // A request that already ended ignores late frames: they are normal races, not violations.
    const entry = pending.get(message.id);
    if (!entry) return;
    try {
      onMessage(message, entry);
    } catch (err) {
      // Nothing may escape a port handler: a malformed message ends its request, not the process.
      cancel(message.id, entry, err, err instanceof Error ? err : new RemoteFetchError(errorMessage(err)));
    }
  });

  port.onClose(() => {
    closed = true;
    for (const [id, entry] of pending) fail(id, entry, new PortClosedError());
  });
  port.start?.();

  const portFetch: PortFetch = (request) => {
    const { signal } = request;
    if (closed) return Promise.reject(new PortClosedError("The port is closed"));
    if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : abortError());
    if (pending.size >= maxConcurrentRequests) {
      counters.busyRejections++;
      return Promise.reject(new PortBusyError(maxConcurrentRequests));
    }
    // A finished response leaves `pending`, but its unread bytes stay queued and no ack can hold
    // them back: past the budget, admit nothing more until they are read or cancelled.
    if (budget.endedBytes > maxQueuedBytes) {
      counters.busyRejections++;
      return Promise.reject(new PortBusyError(maxConcurrentRequests, "unread", maxQueuedBytes));
    }
    const id = nextId++;
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () =>
        cancel(id, entry, signal.reason, signal.reason instanceof Error ? signal.reason : abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      const entry: Pending = {
        resolve,
        reject,
        window: new FlowWindow(windowBytes, counters),
        finished: false,
        settled: false,
        timers: new Map(),
        detachSignal: () => signal.removeEventListener("abort", onAbort),
      };
      pending.set(id, entry);
      arm(id, entry, "headers", headersTimeoutMs);
      arm(id, entry, "total", timeoutMs);

      const hasBody = request.body !== null && request.method !== "GET" && request.method !== "HEAD";
      try {
        send({
          type: "request",
          id,
          v: PROTOCOL_VERSION,
          method: request.method,
          url: request.url,
          headers: headerPairs(request.headers),
          hasBody,
        });
      } catch (err) {
        fail(id, entry, err instanceof Error ? err : new PortClosedError(errorMessage(err)));
        return;
      }
      if (hasBody && request.body) {
        try {
          entry.pump = new BodyPump(
            request.body,
            (chunk): PortMessage => ({ type: "request-chunk", id, chunk }),
            (): PortMessage => ({ type: "request-end", id }),
            send,
            entry.window,
            maxChunkBytes,
          );
        } catch (err) {
          // The body cannot be read (e.g. its reader is taken); the head is out, so cancel it there.
          cancel(id, entry, err, err);
          return;
        }
        entry.pump.done.catch((err: unknown) => {
          // The request body source failed: the server cannot complete the request.
          if (!entry.finished) post(errorFrame(id, err, "body-failed"));
          fail(id, entry, err);
        });
      }
    });
  };

  return Object.assign(portFetch, { stats: () => counters.snapshot(pending.size) });
}

function noop(): void {}

function headerPairs(headers: Headers): HeaderPairs {
  return [...headers];
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}
