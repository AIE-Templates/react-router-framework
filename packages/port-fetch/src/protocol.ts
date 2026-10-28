/**
 * The messages exchanged over one port. Many requests share a port, told apart by `id`, which the
 * client allocates. Binary chunks are plain `Uint8Array`s and are structured-cloned by the port:
 * Electron's `MessagePortMain` can only transfer ports, so there is no zero-copy path and none is
 * promised.
 *
 * Every frame is validated on arrival by `parsePortMessage()`: what is not ours (not an object, an
 * unknown `type`, no usable `id`) is ignored, and a frame that is ours but malformed fails the
 * request its `id` names. The two sides then check it against the request's state.
 */

/**
 * The protocol's major version, carried by every `request` head as `v` (a head without one is
 * version 1, which is what it spoke before the field existed). A server answers a head with a
 * different version with an `error` of code `"protocol"`: both ends must speak the same major
 * version. Changes that old peers can ignore (a new optional field, a new frame type) keep it.
 */
export const PROTOCOL_VERSION = 1;

/** Header name/value pairs, so repeated headers such as `set-cookie` survive the trip. */
export type HeaderPairs = [string, string][];

/** Client → server: a request begins. The body, if any, follows as `request-chunk` messages. */
export interface RequestHeadMessage {
  type: "request";
  id: number;
  /** `PROTOCOL_VERSION` of the client; the client always sends it, a head without it is version 1. */
  v?: number;
  method: string;
  url: string;
  headers: HeaderPairs;
  hasBody: boolean;
}

/** Client → server: a piece of the request body. */
export interface RequestChunkMessage {
  type: "request-chunk";
  id: number;
  chunk: Uint8Array;
}

/** Client → server: the request body is complete. */
export interface RequestEndMessage {
  type: "request-end";
  id: number;
}

/** Server → client: the response status and headers. The body, if any, follows as `response-chunk`. */
export interface ResponseHeadMessage {
  type: "response";
  id: number;
  status: number;
  statusText: string;
  headers: HeaderPairs;
  hasBody: boolean;
}

/** Server → client: a piece of the response body. */
export interface ResponseChunkMessage {
  type: "response-chunk";
  id: number;
  chunk: Uint8Array;
}

/** Server → client: the response body is complete. */
export interface ResponseEndMessage {
  type: "response-end";
  id: number;
}

/**
 * Either direction: the receiver consumed `bytes` of body. Flow control: a sender keeps at most
 * `windowBytes` unacknowledged and waits for acks beyond that, since ports have no backpressure.
 */
export interface AckMessage {
  type: "ack";
  id: number;
  bytes: number;
}

/** Client → server: the client no longer wants the response; the server aborts the request. */
export interface CancelMessage {
  type: "cancel";
  id: number;
  reason?: string;
}

/**
 * Machine-readable reasons an `error` frame carries, for the receiving side to act on (a host can
 * map them to HTTP statuses). A peer may send codes this version does not know; they are
 * passed through as strings.
 *
 * - `busy`: the server was at `maxConcurrentRequests`; `fetch` was not called.
 * - `protocol`: a frame was malformed, out of order, or of another protocol version.
 * - `fetch-failed`: the server's `fetch` threw, or the request could not be built.
 * - `body-failed`: a body stream failed (the response body on the server, the request body on the client).
 * - `invalid-status`: the response had a status the port cannot carry (e.g. `Response.error()`).
 * - `closed`: the server was closed with the request in flight.
 */
export type PortErrorCode = "busy" | "protocol" | "fetch-failed" | "body-failed" | "invalid-status" | "closed";

/**
 * Server → client: the request failed outright (`fetch` threw, or the request could not be built),
 * before or while a response was streaming. Client → server: the request body stream failed.
 * Never carries a stack: `message` and `name` are capped diagnostics, `code` is for programs.
 */
export interface ErrorMessage {
  type: "error";
  id: number;
  message: string;
  code?: PortErrorCode | (string & {});
  /** The failing error's `name` on the sending side, e.g. `TypeError`. */
  name?: string;
}

export type PortMessage =
  | RequestHeadMessage
  | RequestChunkMessage
  | RequestEndMessage
  | ResponseHeadMessage
  | ResponseChunkMessage
  | ResponseEndMessage
  | AckMessage
  | CancelMessage
  | ErrorMessage;

export type PortMessageType = PortMessage["type"];

export const PORT_MESSAGE_TYPES = [
  "request",
  "request-chunk",
  "request-end",
  "response",
  "response-chunk",
  "response-end",
  "ack",
  "cancel",
  "error",
] as const satisfies readonly PortMessageType[];

/** Which side receives a frame: `"server"` for frames the client sends, `"client"` for the others. */
export type Receiver = "client" | "server";

const toServer = new Set<string>(["request", "request-chunk", "request-end", "ack", "cancel", "error"]);
const toClient = new Set<string>(["response", "response-chunk", "response-end", "ack", "error"]);
const allTypes = new Set<string>(PORT_MESSAGE_TYPES);

/** Limits a frame must respect; strings beyond the diagnostic caps are truncated, not rejected. */
export const LIMITS = {
  /** Header pairs per head. */
  headerCount: 256,
  /** Total length of all header names and values per head, in UTF-16 code units. */
  headerLength: 64 * 1024,
  methodLength: 64,
  urlLength: 64 * 1024,
  statusTextLength: 1024,
  /** `error.message` and `cancel.reason` are truncated to this. */
  messageLength: 2 * 1024,
  /** `error.name` is truncated to this. */
  nameLength: 128,
  /** `error.code` is truncated to this. */
  codeLength: 64,
} as const;

/** The outcome of parsing a frame that names a request: the message, or why it is invalid. */
export type ParsedFrame = { ok: true; message: PortMessage } | { ok: false; id: number; reason: string };

/**
 * Validates `value` as a frame `receiver` may get. Returns `undefined` for anything that is not
 * ours (not an object, an unknown `type`, an `id` that is not a non-negative safe integer): the
 * caller ignores it. A frame of a known type with a usable `id` that is malformed, or that travels
 * in the wrong direction, comes back as `{ ok: false, id, reason }` so the caller fails that
 * request. Without `receiver`, both directions are accepted. The returned message is a fresh
 * object holding only the known fields, with diagnostic strings truncated.
 */
export function parsePortMessage(value: unknown, receiver?: Receiver): ParsedFrame | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!isRecord(value)) return undefined;
  const frame = value;
  const { type, id } = frame;
  if (typeof type !== "string" || !allTypes.has(type)) return undefined;
  if (!isId(id)) return undefined;
  const invalid = (reason: string): ParsedFrame => ({ ok: false, id, reason: `Invalid ${type} frame: ${reason}` });
  if (receiver && !(receiver === "server" ? toServer : toClient).has(type)) {
    return invalid(`not expected by the ${receiver}`);
  }
  switch (type) {
    case "request": {
      // Heads from before the field existed are version 1, the protocol they spoke.
      if ((frame.v ?? 1) !== PROTOCOL_VERSION) {
        return {
          ok: false,
          id,
          reason: `Unsupported protocol version ${show(frame.v)}; this side speaks ${PROTOCOL_VERSION}`,
        };
      }
      const { method, url, hasBody } = frame;
      if (typeof method !== "string" || method.length === 0 || method.length > LIMITS.methodLength) {
        return invalid("method");
      }
      if (typeof url !== "string" || url.length > LIMITS.urlLength) return invalid("url");
      if (typeof hasBody !== "boolean") return invalid("hasBody");
      const headers = parseHeaders(frame.headers);
      if (!headers) return invalid("headers");
      return { ok: true, message: { type, id, v: PROTOCOL_VERSION, method, url, headers, hasBody } };
    }
    case "response": {
      const { status, statusText, hasBody } = frame;
      if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) {
        return invalid("status");
      }
      if (typeof statusText !== "string" || statusText.length > LIMITS.statusTextLength) {
        return invalid("statusText");
      }
      if (typeof hasBody !== "boolean") return invalid("hasBody");
      const headers = parseHeaders(frame.headers);
      if (!headers) return invalid("headers");
      return { ok: true, message: { type, id, status, statusText, headers, hasBody } };
    }
    case "request-chunk":
    case "response-chunk": {
      const { chunk } = frame;
      if (!(chunk instanceof Uint8Array)) return invalid("chunk");
      return { ok: true, message: { type, id, chunk } };
    }
    case "request-end":
    case "response-end":
      return { ok: true, message: { type, id } };
    case "ack": {
      const { bytes } = frame;
      if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) return invalid("bytes");
      return { ok: true, message: { type, id, bytes } };
    }
    case "cancel": {
      const { reason } = frame;
      if (reason !== undefined && typeof reason !== "string") return invalid("reason");
      return {
        ok: true,
        message: reason === undefined ? { type, id } : { type, id, reason: cap(reason, LIMITS.messageLength) },
      };
    }
    case "error": {
      const { message, code, name } = frame;
      if (typeof message !== "string") return invalid("message");
      if (code !== undefined && typeof code !== "string") return invalid("code");
      if (name !== undefined && typeof name !== "string") return invalid("name");
      const parsed: ErrorMessage = { type, id, message: cap(message, LIMITS.messageLength) };
      if (code !== undefined) parsed.code = cap(code, LIMITS.codeLength);
      if (name !== undefined) parsed.name = cap(name, LIMITS.nameLength);
      return { ok: true, message: parsed };
    }
    default:
      return undefined;
  }
}

/** Whether `value` is a valid frame of ours, in either direction. */
export function isPortMessage(value: unknown): value is PortMessage {
  return parsePortMessage(value)?.ok === true;
}

/** An `error` frame with its strings capped and no stack, from whatever was thrown. */
export function errorFrame(id: number, err: unknown, code: PortErrorCode): ErrorMessage {
  const message = cap(err instanceof Error ? err.message : String(err), LIMITS.messageLength);
  const frame: ErrorMessage = { type: "error", id, message, code };
  if (err instanceof Error && typeof err.name === "string") frame.name = cap(err.name, LIMITS.nameLength);
  return frame;
}

export function cap(text: string, length: number): string {
  return text.length > length ? text.slice(0, length) : text;
}

/** Lets the parser read any field as `unknown`; every field is checked before use. No allocation. */
function isRecord(value: object): value is Partial<Record<string, unknown>> {
  return !Array.isArray(value);
}

function isId(id: unknown): id is number {
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 0;
}

function parseHeaders(value: unknown): HeaderPairs | undefined {
  if (!Array.isArray(value) || value.length > LIMITS.headerCount) return undefined;
  const headers: HeaderPairs = [];
  let length = 0;
  for (const pair of value as unknown[]) {
    if (!Array.isArray(pair) || pair.length !== 2) return undefined;
    const [name, headerValue] = pair as unknown[];
    if (typeof name !== "string" || typeof headerValue !== "string") return undefined;
    length += name.length + headerValue.length;
    if (length > LIMITS.headerLength) return undefined;
    headers.push([name, headerValue]);
  }
  return headers;
}

function show(value: unknown): string {
  return typeof value === "number" || typeof value === "string" ? String(value) : typeof value;
}

/** Default flow-control window: unacknowledged body bytes a sender may have in flight per request. */
export const DEFAULT_WINDOW_BYTES = 1024 * 1024;
/** Default cap on requests in flight per connection, on each side. */
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 256;
/** Default budget for body bytes received but not yet consumed, per connection (README, Budgets). */
export const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024;
