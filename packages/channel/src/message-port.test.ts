// @vitest-environment node
import { MessageChannel } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import {
  type ChannelCloseInfo,
  CLOSE_CODES,
  frameBytes,
  MAX_CLOSE_REASON_BYTES,
  opened,
  utf8Length,
} from "./channel.ts";
import { channelFromPort, fromNodePort, type PortChannel, type PortChannelOptions } from "./message-port.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** A port channel whose peer is a raw port the test drives frame by frame. */
function rawPeer(options: PortChannelOptions = {}) {
  const { port1, port2 } = new MessageChannel();
  const channel = channelFromPort(fromNodePort(port1), options);
  const frames: Record<string, unknown>[] = [];
  port2.on("message", (frame: Record<string, unknown>) => frames.push(frame));
  cleanups.push(() => {
    channel.close();
    port1.close();
    port2.close();
  });
  const post = (frame: unknown) => port2.postMessage(frame);
  return { channel, frames, post, port: port2 };
}

/** `rawPeer()` after the raw side sent a valid `open`. */
async function openRawPeer(options: PortChannelOptions = {}) {
  const peer = rawPeer(options);
  peer.post({ t: "open", v: 1 });
  await opened(peer.channel);
  return peer;
}

async function portPair(a: PortChannelOptions = {}, b: PortChannelOptions = a) {
  const { port1, port2 } = new MessageChannel();
  const left = channelFromPort(fromNodePort(port1), a);
  const right = channelFromPort(fromNodePort(port2), b);
  cleanups.push(() => {
    left.close();
    right.close();
  });
  await Promise.all([opened(left), opened(right)]);
  return { a: left, b: right };
}

function closeInfo(channel: PortChannel): Promise<ChannelCloseInfo> {
  return new Promise((resolve) => channel.onClose(resolve));
}

const framesOfType = (frames: Record<string, unknown>[], t: string) => frames.filter((frame) => frame.t === t);

describe("port frames: validation", () => {
  it.each([
    ["bytes that do not match the payload", { t: "data", d: new Uint8Array(4), bytes: 3 }],
    ["bytes that do not match a string's UTF-8 length", { t: "data", d: "\u9519", bytes: 1 }],
    ["negative bytes", { t: "data", d: new Uint8Array(0), bytes: -1 }],
    ["fractional bytes", { t: "data", d: new Uint8Array(1), bytes: 1.5 }],
    ["NaN bytes", { t: "data", d: new Uint8Array(1), bytes: Number.NaN }],
    ["missing bytes", { t: "data", d: "x" }],
    ["a payload that is neither string nor Uint8Array", { t: "data", d: 42, bytes: 0 }],
    ["a payload of another typed array", { t: "data", d: new Uint16Array(1), bytes: 2 }],
    ["an infinite ack", { t: "ack", bytes: Number.POSITIVE_INFINITY }],
    ["a negative ack", { t: "ack", bytes: -5 }],
    ["a close code below 1000", { t: "close", code: 999 }],
    ["a close code above 4999", { t: "close", code: 5000 }],
    ["a fractional close code", { t: "close", code: 1000.5 }],
    ["a close reason that is not a string", { t: "close", code: 1000, reason: 7 }],
    ["caps that are not an object", { t: "open", v: 1, caps: "all" }],
    ["a version that is not a positive integer", { t: "open", v: 0 }],
  ])("closes with 1002 on %s, and tells the peer", async (_name, frame) => {
    const peer = frame.t === "open" ? rawPeer() : await openRawPeer();
    const closed = closeInfo(peer.channel);

    peer.post(frame);

    const info = await closed;
    expect(info.code).toBe(CLOSE_CODES.protocolError);
    expect(info.reason).toMatch(/^Protocol error: /);
    expect(info.error).toBeInstanceOf(Error);
    expect(peer.channel.stats().protocolErrors).toBe(1);
    await tick();
    expect(framesOfType(peer.frames, "close")).toEqual([{ t: "close", code: 1002, reason: info.reason }]);
  });

  it.each([
    ["data", { t: "data", d: "early", bytes: 5 }],
    ["ack", { t: "ack", bytes: 0 }],
  ])("closes with 1002 on %s before open", async (_name, frame) => {
    const peer = rawPeer();
    const closed = closeInfo(peer.channel);

    peer.post(frame);

    const info = await closed;
    expect(info.code).toBe(CLOSE_CODES.protocolError);
    expect(info.reason).toContain("before open");
    expect(peer.channel.everOpened).toBe(false);
  });

  it("ignores unknown frame types and non-frames, and stays open", async () => {
    const peer = await openRawPeer();
    const received: unknown[] = [];
    peer.channel.onMessage((data) => {
      received.push(data);
    });

    peer.post({ t: "future-frame", x: 1 });
    peer.post("not a frame");
    peer.post({ no: "t" });
    peer.post(null);
    peer.post({ t: "data", d: "ok", bytes: 2 });
    await tick();

    expect(peer.channel.state).toBe("open");
    expect(received).toEqual(["ok"]);
  });

  it("accepts a zero-byte frame and a multi-byte string with matching counts", async () => {
    const peer = await openRawPeer();
    const received: unknown[] = [];
    peer.channel.onMessage((data) => {
      received.push(data);
    });

    peer.post({ t: "data", d: new Uint8Array(0), bytes: 0 });
    peer.post({ t: "data", d: "\u9519\u8bef", bytes: 6 });
    await tick();

    expect(peer.channel.state).toBe("open");
    expect(received).toHaveLength(2);
    expect(framesOfType(peer.frames, "ack")).toEqual([
      { t: "ack", bytes: 0 },
      { t: "ack", bytes: 6 },
    ]);
  });

  it("clamps an ack larger than what is outstanding and counts it, without closing", async () => {
    const peer = await openRawPeer();
    peer.channel.send(new Uint8Array(100));
    expect(peer.channel.bufferedAmount).toBe(100);

    peer.post({ t: "ack", bytes: 1_000_000 });
    await tick();

    expect(peer.channel.state).toBe("open");
    expect(peer.channel.bufferedAmount).toBe(0);
    expect(peer.channel.stats()).toMatchObject({ acksReceived: 1, acksClamped: 1 });
  });

  it("cuts a received close reason to 123 UTF-8 bytes", async () => {
    const peer = await openRawPeer();
    const closed = closeInfo(peer.channel);

    peer.post({ t: "close", code: 4001, reason: "\u9519".repeat(60) });

    const info = await closed;
    expect(info.code).toBe(4001);
    expect(new TextEncoder().encode(info.reason).byteLength).toBeLessThanOrEqual(MAX_CLOSE_REASON_BYTES);
    expect(info.reason).toBe("\u9519".repeat(41));
  });

  it("cuts a sent close reason to 123 UTF-8 bytes and rejects close codes outside 1000-4999", async () => {
    const peer = await openRawPeer();
    expect(() => peer.channel.close(999)).toThrow(RangeError);
    expect(() => peer.channel.close(5000)).toThrow(RangeError);
    expect(peer.channel.state).toBe("open");

    peer.channel.close(4001, "x".repeat(200));
    await tick();

    expect(framesOfType(peer.frames, "close")).toEqual([{ t: "close", code: 4001, reason: "x".repeat(123) }]);
  });
});

describe("port channel options", () => {
  it.each<[string, PortChannelOptions]>([
    ["a zero window", { windowBytes: 0 }],
    ["a negative window", { windowBytes: -1 }],
    ["a fractional window", { windowBytes: 1.5 }],
    ["an infinite window", { windowBytes: Number.POSITIVE_INFINITY }],
    ["a NaN window", { windowBytes: Number.NaN }],
    ["a low-water mark above the window", { windowBytes: 1024, lowWaterBytes: 2048 }],
    ["a negative low-water mark", { lowWaterBytes: -1 }],
    ["a zero idle timeout", { idleTimeoutMs: 0 }],
    ["a NaN idle timeout", { idleTimeoutMs: Number.NaN }],
    ["an idle timeout beyond what timers allow", { idleTimeoutMs: 2 ** 31 }],
    ["zero coalesced bytes", { ackCoalesce: { bytes: 0 } }],
    ["zero coalesced frames", { ackCoalesce: { frames: 0 } }],
    ["a negative coalescing delay", { ackCoalesce: { delayMs: -1 } }],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately the wrong type
    ["capabilities that are an array", { capabilities: [] as unknown as Record<string, unknown> }],
    ["capabilities a port cannot clone", { capabilities: { callback: () => {} } }],
  ])("throws synchronously on %s, before touching the port", (_name, options) => {
    let touched = false;
    const port = {
      postMessage: () => (touched = true),
      onMessage: () => ((touched = true), () => {}),
      onClose: () => ((touched = true), () => {}),
      close: () => {},
    };
    expect(() => channelFromPort(port, options)).toThrow(/must|could not be cloned/);
    expect(touched).toBe(false);
  });
});

describe("port handshake", () => {
  it("sends the protocol version and capabilities in open, and exposes the peer's", async () => {
    const { a, b } = await portPair({ capabilities: { resize: true, maxCols: 500 } }, {});

    expect(b.peerCapabilities).toEqual({ resize: true, maxCols: 500 });
    expect(Object.isFrozen(b.peerCapabilities)).toBe(true);
    expect(a.peerCapabilities).toEqual({});
  });

  it("puts v and caps on the wire", async () => {
    const peer = rawPeer({ capabilities: { x: 1 } });
    await tick();
    expect(peer.frames[0]).toEqual({ t: "open", v: 1, caps: { x: 1 } });
  });

  it("closes with 1002 and a reason when the peer speaks another major version", async () => {
    const peer = rawPeer();
    const closed = closeInfo(peer.channel);

    peer.post({ t: "open", v: 2 });

    const info = await closed;
    expect(info.code).toBe(CLOSE_CODES.protocolError);
    expect(info.reason).toContain("v2");
    expect(peer.channel.everOpened).toBe(false);
  });

  it("treats an open without v as version 1", async () => {
    const peer = rawPeer();
    peer.post({ t: "open" });
    await opened(peer.channel);
    expect(peer.channel.peerCapabilities).toEqual({});
  });
});

describe("ack coalescing", () => {
  it("acknowledges immediately, one ack per frame, by default", async () => {
    const peer = await openRawPeer();
    peer.channel.onMessage(() => {});
    for (let i = 0; i < 3; i++) peer.post({ t: "data", d: "abc", bytes: 3 });
    await tick();
    expect(framesOfType(peer.frames, "ack")).toHaveLength(3);
    expect(peer.channel.stats()).toMatchObject({ acksSent: 3, acksCoalesced: 0, heldBytes: 0 });
  });

  it("sends one ack once the byte threshold is reached", async () => {
    const { a, b } = await portPair({}, { ackCoalesce: { bytes: 4096, frames: 1000, delayMs: 10_000 } });
    b.onMessage(() => {});

    for (let i = 0; i < 3; i++) a.send(new Uint8Array(1024));
    await tick();
    expect(a.bufferedAmount).toBe(3072);
    expect(b.stats()).toMatchObject({ acksSent: 0, heldBytes: 3072, heldFrames: 3 });

    a.send(new Uint8Array(1024));
    await tick();
    expect(a.bufferedAmount).toBe(0);
    expect(b.stats()).toMatchObject({ acksSent: 1, acksCoalesced: 3, heldBytes: 0, heldFrames: 0 });
  });

  it("sends one ack once the frame threshold is reached", async () => {
    const { a, b } = await portPair({}, { ackCoalesce: { bytes: 1 << 20, frames: 4, delayMs: 10_000 } });
    b.onMessage(() => {});
    for (let i = 0; i < 8; i++) a.send("x");
    await tick();
    expect(a.bufferedAmount).toBe(0);
    expect(b.stats()).toMatchObject({ acksSent: 2, acksCoalesced: 6 });
  });

  it("flushes a small tail after delayMs, so a producer waiting on the window is never stuck", async () => {
    const { a, b } = await portPair(
      { windowBytes: 64 },
      { ackCoalesce: { bytes: 1 << 20, frames: 1000, delayMs: 40 } },
    );
    b.onMessage(() => {});
    a.send(new Uint8Array(64));
    await tick(10);
    expect(a.bufferedAmount).toBe(64);

    await a.whenDrained();
    expect(a.bufferedAmount).toBe(0);
    expect(b.stats().acksSent).toBe(1);
  });

  it("never acknowledges bytes whose handlers have not settled", async () => {
    const { a, b } = await portPair({}, { ackCoalesce: { bytes: 1, frames: 1000, delayMs: 0 } });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    b.onMessage((data) => (frameBytes(data) === 100 ? gate : undefined));

    a.send(new Uint8Array(100)); // held by the gate
    a.send(new Uint8Array(10)); // consumed at once
    await tick();
    expect(a.bufferedAmount).toBe(100);
    expect(b.stats().heldBytes).toBe(100);

    release?.();
    await tick();
    expect(a.bufferedAmount).toBe(0);
    expect(b.stats()).toMatchObject({ acksSent: 2, heldBytes: 0 });
  });

  it("flushes pending acks before its own close frame", async () => {
    const peer = await openRawPeer({ ackCoalesce: { bytes: 1 << 20, frames: 1000, delayMs: 10_000 } });
    peer.channel.onMessage(() => {});
    peer.post({ t: "data", d: "abc", bytes: 3 });
    peer.post({ t: "data", d: "de", bytes: 2 });
    await tick();
    expect(framesOfType(peer.frames, "ack")).toEqual([]);

    peer.channel.close(4001, "bye");
    await tick();

    expect(peer.frames.slice(1)).toEqual([
      { t: "ack", bytes: 5 },
      { t: "close", code: 4001, reason: "bye" },
    ]);
  });

  it("clears the pending ack timer on a remote close and on an idle timeout", async () => {
    const peer = await openRawPeer({ ackCoalesce: { bytes: 1 << 20, frames: 1000, delayMs: 30 } });
    peer.channel.onMessage(() => {});
    peer.post({ t: "data", d: "abc", bytes: 3 });
    peer.post({ t: "close", code: 1000 });
    await tick(80);
    expect(framesOfType(peer.frames, "ack")).toEqual([]);
    expect(peer.channel.stats().heldBytes).toBe(0);

    const idle = await openRawPeer({ idleTimeoutMs: 40, ackCoalesce: { bytes: 1 << 20, frames: 1000, delayMs: 200 } });
    idle.channel.onMessage(() => {});
    idle.post({ t: "data", d: "abc", bytes: 3 });
    const info = await closeInfo(idle.channel);
    expect(info.code).toBe(CLOSE_CODES.idleTimeout);
    await tick(250);
    expect(framesOfType(idle.frames, "ack")).toEqual([]);
  });
});

describe("port channel stats", () => {
  it("counts frames and bytes both ways", async () => {
    const { a, b } = await portPair();
    b.onMessage(() => {});
    a.send("héllo");
    a.send(new Uint8Array(10));
    await tick();

    expect(a.stats()).toMatchObject({ framesSent: 2, bytesSent: 16, acksReceived: 2, framesReceived: 0 });
    expect(b.stats()).toMatchObject({ framesReceived: 2, bytesReceived: 16, acksSent: 2, heldBytes: 0 });
  });

  it("measures time spent waiting for drain", async () => {
    const { a, b } = await portPair({ windowBytes: 16 });
    b.onMessage(async () => {
      await tick(30);
    });
    a.send(new Uint8Array(16));
    await a.whenDrained();
    expect(a.stats().drainWaitMs).toBeGreaterThanOrEqual(20);
  });
});

describe("utf8Length", () => {
  it.each(["", "ascii", "héllo", "\u9519\u8bef", "😀", "\ud800", "a\udc00b", "\ud83d", "x".repeat(2000) + "\u9519"])(
    "matches TextEncoder for %j",
    (text) => {
      expect(utf8Length(text)).toBe(new TextEncoder().encode(text).byteLength);
    },
  );
});
