import {
  type Channel,
  type ChannelCloseInfo,
  type ChannelState,
  type ChannelStats,
  CLOSE_CODES,
  DRAINED,
  emptyStats,
  frameBytes,
  Handlers,
  type MessageHandler,
  normalizeCloseReason,
  utf8Length,
} from "./channel.ts";
import { DEFAULT_WINDOW_BYTES, SendWindow } from "./flow-control.ts";
import type { AckCoalesceOptions } from "./message-port.ts";
import { checkInteger, checkMs, now, snapshot } from "./options.ts";

/**
 * The WebSocket subprotocol that switches a WebSocket channel to end-to-end credit (see
 * `WebSocketChannelOptions.credit`). The client offers it (`new WebSocket(url, [CREDIT_SUBPROTOCOL])`),
 * the server selects it (`ws`: `handleProtocols`); a channel whose socket negotiated it speaks the
 * credit protocol, any other socket stays plain. Offer it only to servers that speak it: a client
 * (browser, Node's `WebSocket`, `ws`) fails the handshake when the server selects none, and `ws`'s
 * server without `handleProtocols` selects the first one offered whether or not its channel speaks
 * it. So deploy servers before clients, and never offer it to an external gateway.
 */
export const CREDIT_SUBPROTOCOL = "repo-channel.credit.v1";

/** Version in the credit `open` control message; a peer announcing another one is a protocol error. */
export const CREDIT_PROTOCOL_VERSION = 1;

/**
 * The largest credit control message accepted, in UTF-8 bytes including its U+0000 prefix (the
 * ones this package sends are under 60). Checked before the message is parsed, for every control
 * message (known or not, before or after `open`); a bigger one is a protocol error. Independent of
 * `maxMessageBytes`, which bounds application messages only.
 */
export const MAX_CONTROL_MESSAGE_BYTES = 1024;

/**
 * What `channelFromWebSocket()` needs of a socket: the browser `WebSocket`, Node's global one, and
 * the `ws` package's (server side included) all have it.
 */
export interface WebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  /** The negotiated subprotocol (`""` when none); `CREDIT_SUBPROTOCOL` turns on credit mode. */
  readonly protocol?: string;
  /**
   * The standard one-argument `send`. Node's `ws` also accepts `send(data, options, callback)`,
   * which `sendWithCallback` uses; that form is not part of this type so standard sockets fit it.
   */
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  removeEventListener(type: "open", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
  removeEventListener(type: "error", listener: (event: unknown) => void): void;
  /** Node's `ws` sockets can stop reading from the network; the standard `WebSocket` cannot. */
  pause?(): void;
  resume?(): void;
}

export interface WebSocketChannelOptions {
  /**
   * `whenDrained()` resolves once `bufferedAmount` is at or below this.
   *
   * Plain mode: the socket's `bufferedAmount`; defaults to 512 KiB.
   *
   * Credit mode: what the peer has not acknowledged, and the mark derives from the peer's announced
   * window. Left unset, it is half of that window (512 KiB against the default 1 MiB window), so it
   * follows a peer that enlarges its window; set, it is the lower of this and half the window, so an
   * explicit value can only lower the mark.
   */
  lowWaterBytes?: number;
  /**
   * How often `whenDrained()` re-checks `bufferedAmount` while someone waits; sockets have no drain
   * event. One timer per channel serves every waiter and runs only while there are waiters.
   * Defaults to 5 ms.
   */
  drainPollMs?: number;
  /**
   * Send with `socket.send(data, {}, callback)` (Node's `ws`) and re-check `bufferedAmount` when a
   * write completes instead of polling; polling resumes only if no write is in flight and the
   * buffer is still above the low-water mark. Opt-in, never guessed from the socket's shape: pass
   * `true` only for a socket that calls `callback` once for every write, success or failure (a `ws`
   * socket does); a socket that ignores it would leave `whenDrained()` waiting until the channel
   * closes. Defaults to `false`: the shared poll, which works with any socket.
   */
  sendWithCallback?: boolean;
  /**
   * Bytes of received frames whose `onMessage` handlers have not settled yet, beyond which a
   * pausable socket (`ws`) stops reading and any other socket is closed with `CLOSE_CODES.overloaded`.
   * Defaults to 1 MiB; a paused socket resumes at half of it. The check runs after a whole message
   * was decoded, so one message of N bytes is held in full before anything pauses: the memory bound
   * is `maxPendingBytes` plus the largest message. Bound messages with `maxMessageBytes` (and the
   * server's `maxPayload` for `ws`) when that matters. In credit mode the bound is the larger of
   * this and twice the window, counted ahead of the message just received: a sender that respects
   * its credit may always send one more whole message, of any size up to `maxMessageBytes`.
   */
  maxPendingBytes?: number;
  /**
   * Received messages whose `onMessage` handlers have not settled yet. Once this many are pending
   * (the count reaches the limit), a plain-mode socket that can pause (`ws`) stops reading and
   * resumes once both counts are at or below half their limit, and any other socket is closed with
   * `CLOSE_CODES.overloaded`. In credit mode reaching it always closes with
   * `CLOSE_CODES.overloaded`, pausable socket or not: pausing would also stop the peer's
   * acknowledgements, and a handler waiting for its own `whenDrained()` would hang the channel.
   * Bytes alone cannot bound this: an empty message counts 0 bytes everywhere, on the wire and in
   * credit, yet each pending one costs memory. Credit does not raise it (credit counts bytes), so a
   * peer within its credit can reach it with messages averaging under `windowBytes /
   * maxPendingFrames` bytes. Defaults to 32768, the relay's `maxQueuedFrames`.
   */
  maxPendingFrames?: number;
  /**
   * Largest message accepted: a received message bigger than this closes the channel with
   * `CLOSE_CODES.messageTooBig` (1009; 4009 on the wire) without delivering it. Default: none.
   * It bounds what one message makes the channel hold; the socket itself may still have buffered
   * the message, so pair it with the server-side limit (`ws`: `maxPayload`) for a strict bound.
   * Application messages only: credit control messages have their own `MAX_CONTROL_MESSAGE_BYTES`.
   */
  maxMessageBytes?: number;
  /**
   * Tunes end-to-end credit, which is on only when the socket negotiated `CREDIT_SUBPROTOCOL` (both
   * ends then speak it, whether or not they pass this option; any other socket ignores it and stays
   * plain). In credit mode each side announces `windowBytes`, the bytes it lets the peer have
   * unacknowledged, and acknowledges a message once every `onMessage` handler settled; the sender's
   * `bufferedAmount` is what the peer has not acknowledged and `whenDrained()` waits for its
   * acknowledgements, so a slow consumer slows the producer down end to end, across the socket
   * buffers of both hosts.
   */
  credit?: CreditOptions;
}

export interface CreditOptions {
  /**
   * The receive window this side grants the peer. Defaults to 1 MiB. The peer's low-water mark
   * follows it (half of it, unless the peer set a lower `lowWaterBytes`), so for large messages set
   * it to several times the message size: with 1 MiB messages and the default window only one
   * message is in flight.
   */
  windowBytes?: number;
  /**
   * How consumed bytes are batched into one acknowledgement: once `bytes` (default a quarter of
   * `windowBytes`) or `frames` (default 32) accumulated, or `delayMs` (default 1) after the first
   * unacknowledged one. Always on in credit mode: a WebSocket message per data message would double
   * the message rate of small frames.
   */
  ackCoalesce?: AckCoalesceOptions;
}

interface ResolvedCredit {
  windowBytes: number;
  ackBytes: number;
  ackFrames: number;
  ackDelayMs: number;
}

function resolveCredit(credit: CreditOptions | undefined): ResolvedCredit {
  if (credit !== undefined && (typeof credit !== "object" || credit === null)) {
    throw new TypeError("credit must be an object");
  }
  const windowBytes = credit?.windowBytes ?? DEFAULT_WINDOW_BYTES;
  checkInteger("credit.windowBytes", windowBytes, 1);
  const { bytes = Math.max(1, Math.floor(windowBytes / 4)), frames = 32, delayMs = 1 } = credit?.ackCoalesce ?? {};
  checkInteger("credit.ackCoalesce.bytes", bytes, 1);
  checkInteger("credit.ackCoalesce.frames", frames, 1);
  checkMs("credit.ackCoalesce.delayMs", delayMs, { positive: false });
  return { windowBytes, ackBytes: bytes, ackFrames: frames, ackDelayMs: delayMs };
}

/**
 * Credit mode's control messages travel as text messages starting with U+0000; an application
 * string that starts with U+0000 is sent with one more in front, so the two never collide and
 * binary messages are never touched.
 */
const CONTROL_PREFIX = "\u0000";
type CreditControl = { t: "open"; v: number; window: number } | { t: "ack"; bytes: number };

function isCount(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

/** Parses a control message; `undefined` for an unknown `t` (ignored, like the port protocol). */
function parseControl(text: string): CreditControl | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("a control message is not JSON");
  }
  if (typeof value !== "object" || value === null) throw new Error("a control message has no type");
  const t: unknown = Reflect.get(value, "t");
  if (typeof t !== "string") throw new Error("a control message has no type");
  if (t === "open") {
    const v: unknown = Reflect.get(value, "v");
    const window: unknown = Reflect.get(value, "window");
    if (!isCount(v, 1)) throw new Error("open: v must be a positive integer");
    if (!isCount(window, 1)) throw new Error("open: window must be a positive integer");
    return { t, v, window };
  }
  if (t === "ack") {
    const bytes: unknown = Reflect.get(value, "bytes");
    if (!isCount(bytes, 0)) throw new Error("ack: bytes must be a non-negative integer");
    return { t, bytes };
  }
  return undefined;
}

/**
 * A `Channel` over a WebSocket, plain unless the socket negotiated `CREDIT_SUBPROTOCOL`.
 *
 * Plain mode: there is no handshake of its own: the socket's `open` is the handshake, and an
 * application-level hello (protocol version, capabilities, authentication result) for a gateway
 * belongs to the protocol running above the channel, so a relay forwards it like any other message.
 * Sending: backpressure is the socket's own `bufferedAmount` (bytes not yet handed to the network);
 * no acknowledgements are exchanged.
 *
 * Credit mode: each side sends an `open` control message with its receive window and the channel
 * opens once the peer's arrives; received messages are acknowledged once their handlers settled,
 * and `bufferedAmount`/`whenDrained()` follow the peer's acknowledgements (see `credit`). Control
 * messages are capped at `MAX_CONTROL_MESSAGE_BYTES`; a malformed one fails the channel with
 * `CLOSE_CODES.protocolError` and an `error`, and nothing received after it is delivered.
 *
 * Receiving, both modes: a handler that returns a promise keeps the frame "pending" until it
 * settles; at `maxPendingBytes` (or `maxPendingFrames` messages) a socket that can pause (`ws`)
 * stops reading until the consumer catches up (except at the message count in credit mode, which
 * always closes), and a socket that cannot (the standard `WebSocket`) is closed with
 * `CLOSE_CODES.overloaded`, since the alternative is unbounded memory. Servers keep connections
 * alive with protocol-level pings, so no heartbeat is added here.
 */
export function channelFromWebSocket(socket: WebSocketLike, options: WebSocketChannelOptions = {}): Channel {
  checkInteger("lowWaterBytes", options.lowWaterBytes, 0);
  checkMs("drainPollMs", options.drainPollMs, { positive: true });
  checkInteger("maxPendingBytes", options.maxPendingBytes, 1);
  checkInteger("maxPendingFrames", options.maxPendingFrames, 1);
  checkInteger("maxMessageBytes", options.maxMessageBytes, 0);
  if (options.sendWithCallback !== undefined && typeof options.sendWithCallback !== "boolean") {
    throw new TypeError("sendWithCallback must be a boolean");
  }
  return new WebSocketChannel(socket, options, resolveCredit(options.credit));
}

/**
 * `WebSocket.close()` only accepts 1000 and 3000–4999; codes a transport produced (1006, 1011) are
 * mapped to what can be sent so a close can be relayed onto a socket.
 */
export function sendableCloseCode(code: number | undefined): number {
  if (code === undefined) return CLOSE_CODES.normal;
  if (code === CLOSE_CODES.normal || (code >= 3000 && code <= 4999)) return code;
  if (code === CLOSE_CODES.internalError) return 4011;
  if (code === CLOSE_CODES.messageTooBig) return 4009;
  if (code === CLOSE_CODES.protocolError) return 4002;
  return 4006;
}

/** `ws`'s three-argument `send`. */
type SendWithCallback = (data: string | Uint8Array, options: object, callback: (error?: Error) => void) => void;

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;

class WebSocketChannel implements Channel {
  readonly #socket: WebSocketLike;
  readonly #lowWaterBytes: number;
  /** `lowWaterBytes` as the application passed it: in credit mode, unset means half the peer's window. */
  readonly #explicitLowWaterBytes: number | undefined;
  readonly #drainPollMs: number;
  readonly #open = new Handlers<[]>();
  readonly #message = new Handlers<Parameters<MessageHandler>>();
  readonly #closed = new Handlers<[ChannelCloseInfo]>();
  readonly #maxPendingBytes: number;
  readonly #maxPendingFrames: number;
  readonly #maxMessageBytes: number | undefined;
  #pendingBytes = 0;
  /** Messages whose handlers have not settled: bytes miss empty ones, which count 0. */
  #pendingFrames = 0;
  #paused = false;
  #error: unknown;
  /** `close()` was called: a late credit `open` no longer opens the channel. */
  #closeRequested = false;
  /**
   * A local failure (a protocol error, a message over `maxMessageBytes`, the overload close):
   * reported as the close's `error`; nothing received after it is processed.
   */
  #failure: Error | undefined;
  #finished = false;
  readonly #sendWithCallback: boolean;
  /** Sends whose callback has not run yet (callback mode only). */
  #inFlight = 0;
  #drainWaiters: (() => void)[] = [];
  #drainTimer: ReturnType<typeof setTimeout> | undefined;
  #drainStart = 0;
  #drainWaitedMs = 0;
  readonly #stats = emptyStats();
  readonly #credit: ResolvedCredit;
  /** The socket negotiated `CREDIT_SUBPROTOCOL`: control messages and acknowledgements are in play. */
  #creditMode = false;
  /** Credit mode, once the peer's `open` arrived: what the peer has not acknowledged yet. */
  #window: SendWindow | undefined;
  #ackBytes = 0;
  #ackFrames = 0;
  #ackTimer: ReturnType<typeof setTimeout> | undefined;
  everOpened: boolean;

  constructor(
    socket: WebSocketLike,
    {
      lowWaterBytes: explicitLowWaterBytes,
      drainPollMs = 5,
      maxPendingBytes = 1024 * 1024,
      maxPendingFrames = 32_768,
      maxMessageBytes,
      sendWithCallback = false,
    }: WebSocketChannelOptions,
    credit: ResolvedCredit,
  ) {
    this.#sendWithCallback = sendWithCallback;
    this.#socket = socket;
    this.#explicitLowWaterBytes = explicitLowWaterBytes;
    this.#lowWaterBytes = explicitLowWaterBytes ?? 512 * 1024;
    this.#drainPollMs = drainPollMs;
    this.#maxPendingBytes = maxPendingBytes;
    this.#maxPendingFrames = maxPendingFrames;
    this.#maxMessageBytes = maxMessageBytes;
    this.#credit = credit;
    socket.binaryType = "arraybuffer";
    // A socket wrapped while already open (or closing) counts as opened; its history before the
    // wrapper existed is unknown, so wrap sockets before anything closes them for exact classification.
    // An open socket that negotiated credit opens the channel only once the peer's `open` arrives.
    this.everOpened = socket.readyState === CLOSING || (socket.readyState === OPEN && !this.#startCredit());
    socket.addEventListener("open", this.#onOpen);
    socket.addEventListener("message", this.#onMessage);
    socket.addEventListener("error", this.#onError);
    socket.addEventListener("close", this.#onClose);
  }

  /** On an open socket: if it negotiated credit, announce this side's window and return `true`. */
  #startCredit(): boolean {
    if (this.#socket.protocol !== CREDIT_SUBPROTOCOL) return false;
    this.#creditMode = true;
    this.#socket.send(
      CONTROL_PREFIX + JSON.stringify({ t: "open", v: CREDIT_PROTOCOL_VERSION, window: this.#credit.windowBytes }),
    );
    return true;
  }

  get state(): ChannelState {
    if (this.#finished) return "closed";
    switch (this.#socket.readyState) {
      case CONNECTING:
        return "connecting";
      case OPEN:
        return this.#creditMode && this.#window === undefined ? "connecting" : "open";
      case CLOSING:
        return "closing";
      default:
        return "closed";
    }
  }

  get bufferedAmount(): number {
    return this.#window === undefined ? this.#socket.bufferedAmount : this.#window.outstanding;
  }

  send(data: string | Uint8Array): void {
    if (this.state !== "open") throw new Error(`The channel is ${this.state}`);
    const bytes = frameBytes(data);
    this.#stats.framesSent++;
    this.#stats.bytesSent += bytes;
    if (this.#window !== undefined) {
      // Credit mode: counted until the peer acknowledges it; the socket's own callback is not needed.
      this.#window.sent(bytes);
      this.#socket.send(typeof data === "string" && data.charCodeAt(0) === 0 ? CONTROL_PREFIX + data : data);
    } else if (this.#sendWithCallback) {
      this.#inFlight++;
      (this.#socket.send as SendWithCallback)(data, {}, this.#sent);
    } else {
      this.#socket.send(data);
    }
  }

  /**
   * Resolves once `bufferedAmount` is at or below the low-water mark, or the channel closed.
   *
   * Plain mode: the socket's own `bufferedAmount`, so this is local progress (bytes handed to the
   * network), not delivery or consumption by the peer. All waiters share one check: a send callback
   * in `sendWithCallback` mode, otherwise a single poll timer that exists only while someone waits.
   *
   * Credit mode: what the peer has not acknowledged, i.e. consumed (every handler settled); the
   * mark is half the peer's window, or the lower of that and `lowWaterBytes` when it was passed, and
   * acknowledgements wake the waiters without polling.
   */
  whenDrained(): Promise<void> {
    // Credit mode: the peer's acknowledgements wake the waiters (the socket's buffer is part of
    // what is unacknowledged), so nothing polls.
    if (this.#window !== undefined) return this.#window.whenDrained();
    if (this.#drained()) return Promise.resolve();
    return new Promise((resolve) => {
      if (this.#drainWaiters.length === 0) this.#drainStart = now();
      this.#drainWaiters.push(resolve);
      this.#scheduleDrainCheck();
    });
  }

  get [DRAINED](): boolean {
    return this.#window === undefined ? this.#drained() : this.#window.drained;
  }

  stats(): ChannelStats {
    const waiting = this.#drainWaiters.length > 0 ? now() - this.#drainStart : 0;
    return snapshot({
      ...this.#stats,
      heldBytes: this.#pendingBytes + this.#ackBytes,
      heldFrames: this.#pendingFrames + this.#ackFrames,
      drainWaitMs: this.#drainWaitedMs + waiting + (this.#window?.waitedMs ?? 0),
    });
  }

  #drained(): boolean {
    return this.state === "closed" || this.#socket.bufferedAmount <= this.#lowWaterBytes;
  }

  /** A write completed (or failed: the close event follows): the buffer may have drained. */
  readonly #sent = (): void => {
    this.#inFlight--;
    this.#checkDrain();
  };

  #checkDrain(): void {
    if (this.#drainWaiters.length === 0) return;
    if (this.#drained()) this.#settleDrain();
    else this.#scheduleDrainCheck();
  }

  #scheduleDrainCheck(): void {
    if (this.#drainTimer !== undefined) return;
    // A pending send callback will re-check; poll only when none is outstanding.
    if (this.#sendWithCallback && this.#inFlight > 0) return;
    this.#drainTimer = setTimeout(() => {
      this.#drainTimer = undefined;
      this.#checkDrain();
    }, this.#drainPollMs);
  }

  #settleDrain(): void {
    clearTimeout(this.#drainTimer);
    this.#drainTimer = undefined;
    if (this.#drainWaiters.length === 0) return;
    this.#drainWaitedMs += now() - this.#drainStart;
    const waiters = this.#drainWaiters;
    this.#drainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  onOpen(handler: () => void): () => void {
    return this.#open.add(handler);
  }

  onMessage(handler: MessageHandler): () => void {
    return this.#message.add(handler);
  }

  onClose(handler: (info: ChannelCloseInfo) => void): () => void {
    return this.#closed.add(handler);
  }

  /**
   * Closes with a code the socket accepts and a reason it accepts (at most 123 UTF-8 bytes). If
   * the socket still refuses, the channel is finished here so the other end and any relay are not
   * left waiting.
   */
  close(code?: number, reason?: string): void {
    if (this.state === "closing" || this.state === "closed") return;
    this.#closeRequested = true;
    const sendCode = sendableCloseCode(code);
    const sendReason = normalizeCloseReason(reason);
    try {
      this.#socket.close(sendCode, sendReason);
    } catch (err) {
      try {
        this.#socket.close(sendCode);
      } catch {
        this.#onClose({ code: CLOSE_CODES.abnormal, reason: sendReason ?? "", error: err });
      }
    }
  }

  readonly #onOpen = (): void => {
    if (this.#closeRequested) return;
    if (this.#startCredit()) return;
    this.everOpened = true;
    this.#open.emit();
  };

  /** Credit mode: a control message, prefix included. */
  #onControl(message: string): void {
    // Measured before parsing: the length in UTF-16 units is a lower bound of the UTF-8 length.
    if (message.length > MAX_CONTROL_MESSAGE_BYTES || utf8Length(message) > MAX_CONTROL_MESSAGE_BYTES) {
      this.#protocolError(`a control message over ${MAX_CONTROL_MESSAGE_BYTES} bytes`);
      return;
    }
    let control: CreditControl | undefined;
    try {
      control = parseControl(message.slice(1));
    } catch (error) {
      this.#protocolError(error instanceof Error ? error.message : String(error));
      return;
    }
    if (control === undefined) return;
    if (control.t === "open") {
      if (this.#window !== undefined) {
        this.#protocolError("a second open");
        return;
      }
      if (control.v !== CREDIT_PROTOCOL_VERSION) {
        this.#protocolError(`the peer speaks credit v${control.v}, this side v${CREDIT_PROTOCOL_VERSION}`);
        return;
      }
      this.#window = new SendWindow({
        windowBytes: control.window,
        // Half the peer's window, which an explicit `lowWaterBytes` can only lower.
        lowWaterBytes: Math.min(this.#explicitLowWaterBytes ?? Infinity, Math.floor(control.window / 2)),
      });
      this.everOpened = true;
      this.#open.emit();
      return;
    }
    if (this.#window === undefined) {
      this.#protocolError("ack before open");
      return;
    }
    this.#stats.acksReceived++;
    if (control.bytes > this.#window.outstanding) this.#stats.acksClamped++;
    this.#window.acked(Math.min(control.bytes, this.#window.outstanding));
  }

  #protocolError(detail: string): void {
    this.#stats.protocolErrors++;
    this.#fail(CLOSE_CODES.protocolError, `Protocol error: ${detail}`);
  }

  /**
   * Fails the channel on a limit this side enforces (protocol error, `maxMessageBytes`, overload):
   * from here on nothing received is parsed or delivered (the socket may still hand over messages
   * until its close completes), no acknowledgement goes out, and the close reports `error` with
   * `code`, so a relay stops at once instead of treating it as the end of the peer's stream.
   */
  #fail(code: number, reason: string): void {
    this.#failure = new Error(reason);
    clearTimeout(this.#ackTimer);
    this.#ackTimer = undefined;
    // A paused socket must read on, or the peer's close frame would never arrive; what it still
    // hands over is dropped above.
    if (this.#paused) {
      this.#paused = false;
      this.#socket.resume?.();
    }
    this.close(code, reason);
  }

  /** Credit mode: `bytes` of one message were consumed; acknowledge them in the next batch. */
  #consumed(bytes: number): void {
    if (this.#finished || this.#failure !== undefined) return;
    this.#ackBytes += bytes;
    this.#ackFrames++;
    if (this.#ackBytes >= this.#credit.ackBytes || this.#ackFrames >= this.#credit.ackFrames) {
      this.#flushAcks();
    } else if (this.#ackTimer === undefined) {
      this.#ackTimer = setTimeout(this.#flushAcks, this.#credit.ackDelayMs);
    }
  }

  readonly #flushAcks = (): void => {
    clearTimeout(this.#ackTimer);
    this.#ackTimer = undefined;
    if (this.#ackFrames === 0 || this.#socket.readyState !== OPEN) return;
    this.#stats.acksSent++;
    this.#stats.acksCoalesced += this.#ackFrames - 1;
    const bytes = this.#ackBytes;
    this.#ackBytes = 0;
    this.#ackFrames = 0;
    this.#socket.send(`${CONTROL_PREFIX}{"t":"ack","bytes":${bytes}}`);
  };

  readonly #onMessage = (event: { data: unknown }): void => {
    if (this.#failure !== undefined) return;
    // A credit channel closed before the peer's `open` arrived never opens: whatever still arrives
    // while the socket closes belongs to a session that did not start.
    if (this.#creditMode && this.#window === undefined && (this.#closeRequested || this.#socket.readyState !== OPEN)) {
      return;
    }
    const { data } = event;
    let frame: string | Uint8Array;
    if (typeof data === "string") {
      frame = data;
      if (this.#creditMode && data.charCodeAt(0) === 0) {
        if (data.charCodeAt(1) !== 0) {
          this.#onControl(data);
          return;
        }
        frame = data.slice(1);
      }
    } else if (data instanceof ArrayBuffer) frame = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) frame = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else return;
    if (this.#creditMode && this.#window === undefined) {
      this.#protocolError("data before open");
      return;
    }
    const bytes = frameBytes(frame);
    this.#stats.framesReceived++;
    this.#stats.bytesReceived += bytes;
    if (this.#maxMessageBytes !== undefined && bytes > this.#maxMessageBytes) {
      this.#fail(
        CLOSE_CODES.messageTooBig,
        `A ${bytes}-byte message exceeds maxMessageBytes (${this.#maxMessageBytes})`,
      );
      return;
    }
    const pending = this.#message.emit(frame).filter((result): result is Promise<unknown> => result instanceof Promise);
    if (pending.length === 0) {
      if (this.#creditMode) this.#consumed(bytes);
      return;
    }
    // The consumer is still working on this frame: count it until every handler settled.
    const ahead = this.#pendingBytes;
    this.#pendingBytes += bytes;
    this.#pendingFrames++;
    void Promise.allSettled(pending).then(() => this.#settled(bytes));
    // The message count has no credit to respect (credit counts bytes, and an empty message 0), so
    // it is checked the same way in both modes, including the message just received. In credit mode
    // reaching it fails the channel even on a socket that could pause: a paused socket no longer
    // reads the peer's acknowledgements either, so a handler that waits for its own `whenDrained()`
    // would never settle and the socket would never resume (a hang with no close and no error).
    const overFrames = this.#pendingFrames >= this.#maxPendingFrames;
    if (this.#paused) {
      if (this.#creditMode && overFrames) this.#overloaded(this.#framesBehind());
      return;
    }
    // Credit mode: a sender within its credit sends only while it has less than our window
    // unacknowledged (what is pending here is part of that), and the message it then sends may be
    // of any size. So what was pending ahead of this message is checked, against the larger of
    // `maxPendingBytes` and twice the window: the rule only catches a peer that ignores its credit,
    // and one legal message, however large (`maxMessageBytes` bounds it), never trips it.
    const limit = this.#creditMode
      ? Math.max(this.#maxPendingBytes, 2 * this.#credit.windowBytes)
      : this.#maxPendingBytes;
    const overBytes = (this.#creditMode ? ahead : this.#pendingBytes) >= limit;
    if (!overBytes && !overFrames) return;
    if (this.#socket.pause && this.#socket.resume && !(this.#creditMode && overFrames)) {
      this.#paused = true;
      this.#socket.pause();
    } else {
      this.#overloaded(
        overBytes ? `Receiver fell ${this.#pendingBytes} bytes behind, more than ${limit}` : this.#framesBehind(),
      );
    }
  };

  #framesBehind(): string {
    return `Receiver fell ${this.#pendingFrames} messages behind (maxPendingFrames ${this.#maxPendingFrames})`;
  }

  /** The overload close: a local failure (4008 with an `error`), counted once. */
  #overloaded(reason: string): void {
    if (this.state !== "open") return;
    this.#stats.overloadCloses++;
    this.#fail(CLOSE_CODES.overloaded, reason);
  }

  /** A frame's handlers settled: it is no longer pending; a paused socket resumes at half both limits. */
  #settled(bytes: number): void {
    this.#pendingBytes = Math.max(0, this.#pendingBytes - bytes);
    this.#pendingFrames = Math.max(0, this.#pendingFrames - 1);
    if (this.#creditMode) this.#consumed(bytes);
    if (
      this.#paused &&
      this.#pendingBytes <= this.#maxPendingBytes / 2 &&
      this.#pendingFrames <= this.#maxPendingFrames / 2
    ) {
      this.#paused = false;
      this.#socket.resume?.();
    }
  }

  readonly #onError = (event: unknown): void => {
    // The matching `close` event follows and reports it.
    this.#error = event instanceof Error ? event : new Error("WebSocket error");
  };

  readonly #onClose = (event: { code: number; reason: string; error?: unknown }): void => {
    if (this.#finished) return;
    this.#finished = true;
    this.#socket.removeEventListener("open", this.#onOpen);
    this.#socket.removeEventListener("message", this.#onMessage);
    this.#socket.removeEventListener("error", this.#onError);
    this.#socket.removeEventListener("close", this.#onClose);
    const abnormal = event.code === CLOSE_CODES.abnormal;
    const error =
      "error" in event
        ? event.error
        : (this.#failure ?? this.#error ?? (abnormal ? new Error("The socket closed abnormally") : undefined));
    this.#settleDrain();
    // Acknowledgements are meaningless once closed; waiters for credit are released.
    clearTimeout(this.#ackTimer);
    this.#ackTimer = undefined;
    this.#ackBytes = 0;
    this.#ackFrames = 0;
    this.#window?.close();
    this.#closed.emit({ code: event.code, reason: event.reason, error });
    this.#open.clear();
    this.#message.clear();
    this.#closed.clear();
  };
}
