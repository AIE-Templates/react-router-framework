# @repo/channel

A WebSocket-like bidirectional channel over MessagePort or WebSocket, with a backpressured relay. It is browser/Node code without Electron runtime dependencies. MessagePortMain is adapted structurally. The transport can carry binary frames and text control messages; application authentication and gateway protocols belong above it.

```ts
interface Channel {
  readonly state: "connecting" | "open" | "closing" | "closed";
  readonly everOpened: boolean; // set synchronously when the channel opens, before any onOpen handler runs
  readonly bufferedAmount: number; // bytes sent but not yet taken by the other side
  send(data: string | Uint8Array): void; // strings: control messages (JSON); bytes: binary frames
  whenDrained(): Promise<void>; // resolves once bufferedAmount is at or below the low-water mark
  onOpen(handler: () => void): () => void;
  onMessage(handler: (data: string | Uint8Array) => void | Promise<void>): () => void;
  onClose(handler: (info: { code?: number; reason?: string; error?: unknown }) => void): () => void;
  close(code?: number, reason?: string): void; // 1000 normal, 4000–4999 application
  stats(): ChannelStats; // counters, see "Counters"
}
```

```ts
import {
  channelFromPort,
  fromNodePort,
  fromElectronPort,
  fromEventTargetPort,
  channelFromWebSocket,
} from "@repo/channel";

// A message port: Node (worker_threads), Electron (MessagePortMain) or the DOM (MessagePort).
const a = channelFromPort(fromNodePort(port1), { windowBytes: 1024 * 1024, idleTimeoutMs: 30_000 });
// A WebSocket: the browser's, Node's global, or a `ws` socket on a server.
const b = channelFromWebSocket(new WebSocket("wss://…"));
```

```ts
import { relay } from "@repo/channel";
const link = relay(portChannel, socketChannel);
await link.done; // both closed
```

## Connection and validation

`opened(channel)` waits for an open channel. `everOpened` changes synchronously before open callbacks. Port peers exchange `{ t: "open", v: PROTOCOL_VERSION, caps? }`, version 1. Incompatible versions close with protocol error before opening. Peer capabilities are frozen descriptive metadata, not authorization. WebSocket normally uses its own handshake; optional credit mode negotiates a transport protocol, not application authentication.

Validate known frames before changing state/counters: open version/capabilities, data string or Uint8Array with exact safe-integer byte length, nonnegative safe-integer ACK bytes, close integer code 1000–4999 and string reason. Data/ACK before open is invalid. Unknown optional frames are ignored; excess ACK bytes are clamped and counted. Local invalid close codes throw RangeError. Options validate safe-integer windows/limits/quotas, low water at most window, finite timer-compatible durations and cloneable plain capability objects before touching transport resources.

Close codes include normal 1000, protocol 1002, abnormal transport loss 1006, oversized message 1009, internal failure 1011, idle timeout 4000 and overload 4008. WebSocket-sendable mappings use 4002/4006/4009/4011 where required. Reasons truncate on character boundaries to 123 UTF-8 bytes. If socket.close rejects, terminate locally so peers/relay do not wait forever.

## Backpressure

`send()` neither blocks nor drops frames. Producers must await `whenDrained()`. Port bufferedAmount counts sent bytes not yet acknowledged; the default window is 1 MiB, low water half the window. ACK follows completion of every message handler, including promises, carrying slow-consumer pressure upstream. Idle ping/pong runs at one-third of the configured timeout. Port close without a close frame reports abnormal closure.

Optional `ackCoalesce` batches consumed bytes (defaults 32 KiB, 32 frames, 1ms when enabled). It is off by default. Local close flushes pending ACK; remote close/error/timeout clears it. Batching thresholds should be far below the sender's window. ACK means handler completion, not application persistence.

Plain WebSocket bufferedAmount means bytes not yet handed to the network. Drain polling defaults to 5ms with one shared timer per channel while waiters exist. Explicit `sendWithCallback: true` supports ws-style write callbacks; never infer this from function arity. Use it only when every write reliably calls back. Closing settles drain waiters without promising delivery. Plain drain is local progress; end-to-end credit measures peer acknowledgement, still not business-level success.

## Receive bounds and credit

Pending receive limits default to 1 MiB and 32768 frames. Counts include the newly received message; equality reaches the limit. Async handlers retain pending frames. A pausable socket pauses at the limit and resumes when both counts fall to half. Already decoded messages and one buffered network chunk can still arrive, so maxMessageBytes and the server socket's maxPayload also matter. Nonpausable sockets close with 4008 on overload.

Message-count limits bound empty/tiny frames that consume no byte credit but still allocate memory. In WebSocket credit mode, reaching the frame limit closes with 4008 even on a pausable socket: pausing would also block ACK control messages and deadlock handlers waiting for drain. Byte overload can still pause. In plain mode, handlers must not retain a pending promise while waiting for another message on the same socket if receive pausing could block that message.

Local overload/size/protocol failure stops further parsing/delivery and ACKs while closing; do not continue accepting frames after the failure boundary. Credit mode is explicitly negotiated on both peers; application payloads and transport control frames remain distinct. Peer window, protocol and credit values are validated. The transport limits outstanding work, not the application's authorization or message schema.

## Relay

Relay preserves message order and propagates close/error semantics while awaiting destination readiness and drain. Connection waits, queued bytes and queued frame counts are bounded; too many queued frames close with overload. Empty frames count toward frame limits. Relay does not add an application hello or authentication exchange. Neither relay forwarding nor drain proves that the destination application processed/persisted a message; require an application acknowledgement when that matters.

## Diagnostics and tuning

`stats()` exposes transport/flow-control counters, protocol failures, clamped acknowledgements and queue state. Read counter semantics in the exported types; distinguish cumulative counters from current held-frame gauges. Configure windows, low water, maximum message/pending sizes, timeouts and scheduling quotas for representative workloads. Benchmark slow consumers, recovery and cancellation as well as peak throughput. The package supplies transport adapters; a renderer gateway connection or application BFF route is not automatically installed by using it.

## Credit negotiation and port limitations

The receive bounds above apply to the WebSocket adapter. The port channel has no independent receive byte/frame limit: its window constrains cooperative senders, and zero-byte messages consume no credit. An untrusted port peer plus retained handler promises can grow memory without bound. Enforce application message-count limits or a bounded relay when accepting such peers.

WebSocket credit uses CREDIT_SUBPROTOCOL (`repo-channel.credit.v1`) negotiated in HTTP upgrade. The client offers it only to known supporting servers; the server selects it only when offered. Deploy support on the server first. Offering a subprotocol that the server does not select can fail the handshake; ws without an explicit handleProtocols may select the first offer regardless of application support. Never offer this protocol to an unrelated gateway.

With the negotiated protocol, each side sends a version-1 open containing its receive window and remains connecting until the peer open. credit.windowBytes defaults to 1 MiB; the option tunes the window but does not enable the mode. ACK batching is always enabled here, defaulting to one-quarter window, 32 frames or 1ms. Drain low water defaults to half the peer window; explicit lowWaterBytes is capped at that half-window value. Closing rejects opening waits and releases drain waits; late open cannot reopen a closing channel.

Control text starts with U+0000 and carries open/ack JSON. Application strings starting with U+0000 escape it by doubling; binary frames are unchanged. Control messages are bounded to 1 KiB before parsing, independently of application maxMessageBytes. Invalid controls, incompatible versions, duplicate open or data/ACK before open fail with protocol error and stop delivery. Unknown optional types are ignored. Socket maxPayload is the only limit that prevents oversized payload buffering before the adapter sees it.

Send preserves whole messages, so a single message can cross the credit window. Credit-mode receive byte overload compares pending bytes before that message against max(maxPendingBytes, twice the receive window); memory also includes the largest message. Use maxMessageBytes to bound that contribution. Frame limits still include the incoming frame and close on overload. Local failures carry error and stop relay immediately; receiving a peer close code alone remains an ordinary close.
