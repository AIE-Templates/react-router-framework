/**
 * The application-level wire format every link and variant shares, so raw and package variants
 * carry identical bytes. Data frames are binary with an 8-byte header; everything else is a JSON
 * string. A transport that only moves `string | Uint8Array` (the Channel interface) and a raw
 * `postMessage`/`socket.send` can both carry these as they are.
 */
export const HEADER_BYTES = 8;
export const FLAG_SAMPLE = 1;
/** Every this many data frames (by sequence number) carries `FLAG_SAMPLE`. */
export const SAMPLE_EVERY = 16;

/** Builds a data frame for `seq` with `payload` copied in after the header. */
export function encodeFrame(seq: number, flags: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(HEADER_BYTES + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, seq >>> 0, true);
  view.setUint8(4, flags);
  frame.set(payload, HEADER_BYTES);
  return frame;
}

export function decodeHeader(frame: Uint8Array): { seq: number; flags: number } {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return { seq: view.getUint32(0, true), flags: view.getUint8(4) };
}

/** Control messages: sender → peer. */
export type ControlOut =
  | { t: "rpc"; id: number; pad: string }
  | { t: "barrier"; id: number }
  | { t: "stats" }
  | { t: "measure" };

/** Control messages: peer → sender. */
export type ControlIn =
  | { t: "ack"; seq: number }
  | { t: "credit"; bytes: number }
  | { t: "rpcr"; id: number; pad: string }
  | { t: "barrierr"; id: number; bytes: number; messages: number; lastSeq: number }
  | { t: "statsr"; stats: unknown }
  | { t: "rev-ack"; seq: number };

export type RevAck = { t: "rev-ack"; seq: number };
export type ControlMessage = ControlIn | ControlOut | RevAck;

export function isControl(data: unknown): data is string {
  return typeof data === "string";
}

/** Parses a control message, rebuilding it field by field so a malformed one fails loudly. */
export function parseControl(text: string): ControlMessage {
  const v: unknown = JSON.parse(text);
  if (typeof v !== "object" || v === null || !("t" in v) || typeof v.t !== "string")
    throw new Error("not a control message");
  const tag: string = v.t;
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(v));
  const field = (name: string): unknown => record[name];
  const num = (name: string): number => {
    const value = field(name);
    if (typeof value !== "number") throw new Error(`control ${tag}: ${name} is not a number`);
    return value;
  };
  const str = (name: string): string => {
    const value = field(name);
    return typeof value === "string" ? value : "";
  };
  switch (tag) {
    case "rpc":
      return { t: "rpc", id: num("id"), pad: str("pad") };
    case "barrier":
      return { t: "barrier", id: num("id") };
    case "stats":
      return { t: "stats" };
    case "measure":
      return { t: "measure" };
    case "ack":
      return { t: "ack", seq: num("seq") };
    case "credit":
      return { t: "credit", bytes: num("bytes") };
    case "rpcr":
      return { t: "rpcr", id: num("id"), pad: str("pad") };
    case "barrierr":
      return { t: "barrierr", id: num("id"), bytes: num("bytes"), messages: num("messages"), lastSeq: num("lastSeq") };
    case "statsr":
      return { t: "statsr", stats: field("stats") };
    case "rev-ack":
      return { t: "rev-ack", seq: num("seq") };
    default:
      throw new Error(`unknown control message ${tag}`);
  }
}

/** Pads a JSON control message with spaces to about `bytes`, so RPC sizes are honoured. */
export function padTo(bytes: number, base: Record<string, unknown>): string {
  const skeleton = JSON.stringify({ ...base, pad: "" });
  const missing = Math.max(0, bytes - skeleton.length);
  return JSON.stringify({ ...base, pad: " ".repeat(missing) });
}
