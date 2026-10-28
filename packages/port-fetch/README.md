# @repo/port-fetch

Request/Response transport over message ports, independent of Electron. A client multiplexes requests while `servePort` adapts a standard request handler. Headers, status and bidirectional body streams cross the port. Responses become available at headers rather than after buffering the body. Node worker_threads ports support tests; Electron uses structural adapters.

```ts
import { createPortFetch, fromNodePort, servePort } from "@repo/port-fetch";

// Server side (the utility process): serve a Hono app.
const server = servePort(fromNodePort(port2), (request) => app.fetch(request), { windowBytes });
server.close(); // aborts in-flight requests (the client gets code "closed") and stops listening
server.stats(); // counters for this side

// Client side (the main process): a fetch that goes over the port.
const fetch = createPortFetch(fromNodePort(port1), { windowBytes, timeoutMs });
const response = await fetch(new Request("http://app.desktop/chat/42"));
fetch.stats(); // counters for this side
```

## Protocol and failure behavior

Requests and body frames carry IDs. Protocol version and frame shape are validated before state changes. Unknown optional frames do not grant capabilities. Malformed frames, invalid byte counts and exceeded budgets produce explicit errors rather than uncontrolled allocation. Error codes and configurable budgets are declared in the exported types and protocol implementation; callers should inspect structured errors rather than parse log strings.

AbortSignal, response-body cancellation, timeout, port closure, early response and stream errors clean up both sides idempotently. Cancellation propagates to the handler's request signal and should continue to upstream fetch. Closing a port prevents new requests. Header/request limits and body lifetime are distinct: long-lived streaming bodies must not inherit an arbitrary short request-header deadline.

## Flow control

Each body has its own acknowledgement window. A sender pauses upstream reads when unacknowledged bytes fill that window. Consumption returns credit. Optional ACK coalescing batches consumed bytes using byte/delay thresholds; it changes notification overhead, not message ordering or body contents. Keep batching thresholds comfortably below the sender's window to avoid throughput stalls. Tune using representative small/large/streaming/cancellation workloads, comparing repeated runs.

Copy outgoing chunks into exactly sized Uint8Array buffers. Structured cloning a subarray can clone the whole backing buffer. Transport is not promised to be zero-copy. Electron MessagePortMain transfers ports, not arbitrary ArrayBuffers: call postMessage with one argument. Transfer-list experiments on Electron 45 can fail or silently deliver null and must not be used as a production optimization.

Adapters handle event shape and start semantics. Electron utility ports are transferred after spawn. The transport itself neither chooses application origins nor authenticates senders; host mapping and trust checks belong outside the package.

## Limits and errors

`headersTimeoutMs`, `idleTimeoutMs` and `timeoutMs` respectively bound header wait, body inactivity and whole-request duration. They produce PortFetchTimeoutError (name TimeoutError, phase identifying the stage) and cancel both ends. Unset body/total limits allow indefinite SSE. Port closure produces PortClosedError; remote failures produce RemoteFetchError with code and remoteName. PortBusyError identifies its budget and rejects before sending.

Protocol version is 1; absent request v means 1. Headers are arrays of pairs preserving repeated Set-Cookie. Messages are request, request-chunk, request-end, response, response-chunk, response-end, ack, cancel and error, all keyed by a nonnegative safe-integer ID. Unknown frames/invalid IDs are ignored and counted. Known malformed or wrong-direction frames fail only the matching live request. Late frames for completed requests are ignored. Validate duplicate headers/end frames, body-before-headers and body contradicting hasBody. Excess ACKs clamp to outstanding bytes.

Limits are 256 header pairs totaling 64 KiB, status 200–599, method length 1–64, URL at most 64 KiB, boolean hasBody, real Uint8Array chunks and nonnegative safe-integer byte counts. Error reason/message truncate to 2 KiB, code to 64 characters and name to 128. Error codes include busy, protocol, fetch-failed, invalid-status, body-failed and closed; unknown codes pass through as strings. Errors contain no remote stack.

Concurrent requests default to 256 on each end with no waiting queue. Count until response end/failure, not until the caller consumes all bytes. Queued unread bytes default to 8 MiB per connection. Above that budget, backlogged bodies withhold ACKs; bodies consumed promptly continue acknowledging. One body exceeding the budget violates flow control. Sender window must not exceed receiver maxQueuedBytes.

Completed unread responses no longer count as concurrent requests, so the client also rejects new fetches with budget unread when their retained bytes exceed maxQueuedBytes. Reading/canceling returns budget immediately. A FinalizationRegistry, where available, reclaims abandoned completed streams' accounting without canceling requests; do not rely on collection timing. Streaming bodies use ACK bounds instead. Client unread bytes are bounded by maxQueuedBytes plus maxConcurrentRequests times the peer window; server uploads are discarded after completed responses.

Window defaults to 1 MiB and maxChunkBytes defaults to the window. Larger chunks split. ACK follows consumption rather than arrival. Port-fetch ackCoalesce uses `{ bytes, delayMs }` and a single timer per connection, not per body; it has no frame-count option. Completed/terminated senders discard pending ACKs. Every termination cancels upstream reads, releases reader locks/credit, clears timers/listeners and settles once, including early responses during upload. GET/HEAD never carry a body. Stats report frame types, ignored/invalid frames, protocol errors, bytes, ACK coalescing/clamping/withholding, credit waits, current/peak queues, requests and busy rejections.
