// @vitest-environment node
import { MessageChannel } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket as WsSocket, WebSocketServer } from "ws";

import {
  type Channel,
  type ChannelCloseInfo,
  CLOSE_CODES,
  frameBytes,
  MAX_CLOSE_REASON_BYTES,
  normalizeCloseReason,
  opened,
} from "./channel.ts";
import { channelFromPort, fromNodePort } from "./message-port.ts";
import { relay } from "./relay.ts";
import {
  channelFromWebSocket,
  CREDIT_SUBPROTOCOL,
  sendableCloseCode,
  type WebSocketChannelOptions,
  type WebSocketLike,
} from "./web-socket.ts";

/** A connected pair, and a way to kill `b`'s transport without a close frame. */
interface Pair {
  a: Channel;
  b: Channel;
  breakB: () => void;
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const bytes = (...values: number[]) => new Uint8Array(values);

async function portPair(windowBytes = 1024 * 1024): Promise<Pair> {
  const channel = new MessageChannel();
  const a = channelFromPort(fromNodePort(channel.port1), { windowBytes });
  const b = channelFromPort(fromNodePort(channel.port2), { windowBytes });
  cleanups.push(() => {
    a.close();
    b.close();
    channel.port1.close();
    channel.port2.close();
  });
  await Promise.all([opened(a), opened(b)]);
  return { a, b, breakB: () => channel.port2.close() };
}

/**
 * A socket pair over a local `ws` server. The client is Node's standard `WebSocket` (polling for
 * drain), or with `ws: true` a `ws` client, and both sides use `ws`'s send callback. With
 * `credit: true` the client offers `CREDIT_SUBPROTOCOL` and the server selects it.
 */
async function webSocketPair(
  options: WebSocketChannelOptions = {},
  { ws = false, credit = false } = {},
): Promise<Pair> {
  const server = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    handleProtocols: (protocols) => (protocols.has(CREDIT_SUBPROTOCOL) ? CREDIT_SUBPROTOCOL : false),
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("The test server has no address");
  const serverSocket = new Promise<WebSocketLike>((resolve) => server.once("connection", (socket) => resolve(socket)));
  const url = `ws://127.0.0.1:${address.port}`;
  const protocols = credit ? [CREDIT_SUBPROTOCOL] : [];
  const a = ws
    ? channelFromWebSocket(new WsSocket(url, protocols), { ...options, sendWithCallback: true })
    : channelFromWebSocket(new WebSocket(url, protocols), options);
  const b = channelFromWebSocket(await serverSocket, ws ? { ...options, sendWithCallback: true } : options);
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of server.clients) socket.terminate();
        server.close(() => resolve());
      }),
  );
  await Promise.all([opened(a), opened(b)]);
  return {
    a,
    b,
    breakB() {
      for (const socket of server.clients) socket.terminate();
    },
  };
}

function received(channel: Channel): (string | Uint8Array)[] {
  const frames: (string | Uint8Array)[] = [];
  channel.onMessage((data) => {
    frames.push(data);
  });
  return frames;
}

function closeInfo(channel: Channel): Promise<ChannelCloseInfo> {
  return new Promise((resolve) => channel.onClose(resolve));
}

/** The frame as bytes; fails the test if it was a string. */
function asBytes(frame: string | Uint8Array | undefined): number[] {
  if (!(frame instanceof Uint8Array)) throw new Error(`Expected a binary frame, got ${String(frame)}`);
  return [...frame];
}

describe.each([
  ["MessagePort", portPair],
  ["WebSocket", webSocketPair],
  ["WebSocket (ws on both sides, send callback)", () => webSocketPair({}, { ws: true })],
  ["WebSocket with credit", () => webSocketPair({}, { credit: true })],
  ["WebSocket with credit (ws on both sides)", () => webSocketPair({}, { ws: true, credit: true })],
] as const)("Channel over %s", (_name, connect) => {
  it("delivers strings and bytes in order, bytes as Uint8Array", async () => {
    const { a, b } = await connect();
    const frames = received(b);

    a.send("hello");
    a.send(bytes(1, 2, 3));
    a.send(JSON.stringify({ t: "resize", cols: 80 }));
    a.send(bytes(255, 0));
    await tick(50);

    expect(frames).toHaveLength(4);
    expect(frames[0]).toBe("hello");
    expect(frames[1]).toBeInstanceOf(Uint8Array);
    expect(asBytes(frames[1])).toEqual([1, 2, 3]);
    expect(frames[2]).toBe('{"t":"resize","cols":80}');
    expect(asBytes(frames[3])).toEqual([255, 0]);
  });

  it("flows both ways", async () => {
    const { a, b } = await connect();
    const toA = received(a);
    const toB = received(b);

    a.send("ping");
    b.send("pong");
    await tick(50);

    expect(toB).toEqual(["ping"]);
    expect(toA).toEqual(["pong"]);
  });

  it("drains: whenDrained() resolves after the consumer took the frames", async () => {
    const { a, b } = await connect();
    received(b);
    for (let i = 0; i < 10; i++) a.send(new Uint8Array(64 * 1024));

    await a.whenDrained();
    await tick(50);

    expect(a.bufferedAmount).toBe(0);
  });

  it("closes the far side with the code and reason", async () => {
    const { a, b } = await connect();
    const closedB = closeInfo(b);
    const closedA = closeInfo(a);

    a.close(4001, "done");

    expect(await closedB).toMatchObject({ code: 4001, reason: "done" });
    expect(await closedA).toMatchObject({ code: 4001, reason: "done" });
    expect(a.state).toBe("closed");
    expect(b.state).toBe("closed");
    expect(() => a.send("late")).toThrow("closed");
  });

  it("reports a transport that dropped without a close frame as an abnormal close", async () => {
    const { a, breakB } = await connect();
    const closedA = closeInfo(a);

    breakB();

    const info = await closedA;
    expect(info.code).toBe(CLOSE_CODES.abnormal);
    expect(info.error).toBeInstanceOf(Error);
    expect(a.state).toBe("closed");
  });
});

describe("Channel over MessagePort: flow control", () => {
  it("keeps the sender's outstanding bytes within the window when the consumer is slow", async () => {
    const windowBytes = 4096;
    const { a, b } = await portPair(windowBytes);
    let consumed = 0;
    let maxOutstanding = 0;
    b.onMessage(async (data) => {
      await tick(2);
      consumed += frameBytes(data);
    });

    const chunk = new Uint8Array(1024);
    for (let i = 0; i < 40; i++) {
      if (a.bufferedAmount >= windowBytes) await a.whenDrained();
      a.send(chunk);
      maxOutstanding = Math.max(maxOutstanding, a.bufferedAmount);
    }
    await a.whenDrained();
    await tick(100);

    expect(consumed).toBe(40 * 1024);
    // At most the window plus the frame that filled it.
    expect(maxOutstanding).toBeLessThanOrEqual(windowBytes + 1024);
    expect(a.bufferedAmount).toBe(0);
  });

  it("closes a silent channel at the idle timeout, and keeps a live one open", async () => {
    const channel = new MessageChannel();
    cleanups.push(() => {
      channel.port1.close();
      channel.port2.close();
    });
    // Nobody ever answers on port2: no `open`, no pongs.
    const silent = channelFromPort(fromNodePort(channel.port1), { idleTimeoutMs: 60 });
    const info = await closeInfo(silent);
    expect(info.code).toBe(CLOSE_CODES.idleTimeout);
    expect(info.error).toBeInstanceOf(Error);

    const live = new MessageChannel();
    const a = channelFromPort(fromNodePort(live.port1), { idleTimeoutMs: 60 });
    const b = channelFromPort(fromNodePort(live.port2), { idleTimeoutMs: 60 });
    cleanups.push(() => {
      a.close();
      b.close();
    });
    await Promise.all([opened(a), opened(b)]);
    await tick(200);
    expect(a.state).toBe("open");
    expect(b.state).toBe("open");
  });
});

describe("relay", () => {
  it("crosses frames both ways and closes the far end when one end closes", async () => {
    const left = await portPair();
    const right = await webSocketPair();
    const link = relay(left.b, right.a);
    const toRight = received(right.b);
    const toLeft = received(left.a);

    left.a.send("from left");
    left.a.send(bytes(9, 8));
    right.b.send("from right");
    await tick(80);
    expect(toRight[0]).toBe("from left");
    expect(asBytes(toRight[1])).toEqual([9, 8]);
    expect(toLeft).toEqual(["from right"]);

    const closedRight = closeInfo(right.b);
    left.a.close(4002, "bye");
    expect(await closedRight).toMatchObject({ code: 4002, reason: "bye" });
    await link.done;
    expect(left.b.state).toBe("closed");
    expect(right.a.state).toBe("closed");
  });

  it("applies backpressure through the relay: a fast producer waits for the slow consumer", async () => {
    const windowBytes = 4096;
    const left = await portPair(windowBytes);
    const right = await portPair(windowBytes);
    relay(left.b, right.a);
    let consumed = 0;
    let maxOutstanding = 0;
    right.b.onMessage(async (data) => {
      await tick(2);
      consumed += frameBytes(data);
    });

    const chunk = new Uint8Array(1024);
    for (let i = 0; i < 40; i++) {
      if (left.a.bufferedAmount >= windowBytes) await left.a.whenDrained();
      left.a.send(chunk);
      maxOutstanding = Math.max(maxOutstanding, left.a.bufferedAmount, right.a.bufferedAmount);
    }
    await left.a.whenDrained();
    await tick(200);

    expect(consumed).toBe(40 * 1024);
    expect(maxOutstanding).toBeLessThanOrEqual(windowBytes + 1024);
  });

  it("closes both channels when the relay is closed", async () => {
    const left = await portPair();
    const right = await portPair();
    const link = relay(left.b, right.a);
    const closedA = closeInfo(left.a);
    const closedB = closeInfo(right.b);

    link.close(4003, "shutting down");

    expect(await closedA).toMatchObject({ code: 4003 });
    expect(await closedB).toMatchObject({ code: 4003 });
    await link.done;
  });
});

/** A port channel whose peer is created later (or never): still `connecting`. */
function unopenedPortPair(windowBytes = 1024 * 1024) {
  const channel = new MessageChannel();
  const a = channelFromPort(fromNodePort(channel.port1), { windowBytes });
  cleanups.push(() => {
    channel.port1.close();
    channel.port2.close();
  });
  return {
    a,
    openPeer: () => {
      const b = channelFromPort(fromNodePort(channel.port2), { windowBytes });
      cleanups.push(() => b.close());
      return b;
    },
    killPeer: () => channel.port2.close(),
  };
}

describe("relay: connection setup", () => {
  it("holds frames sent before the destination opens and delivers them in order", async () => {
    const left = await portPair();
    const right = unopenedPortPair();
    const link = relay(left.b, right.a);

    left.a.send("early");
    left.a.send(bytes(1));
    await tick(30);
    expect(right.a.state).toBe("connecting");
    // The source's acknowledgement is held with the frame.
    expect(left.a.bufferedAmount).toBe(frameBytes("early") + 1);

    const rightB = right.openPeer();
    const frames = received(rightB);
    await opened(rightB);
    left.a.send("late");
    await tick(50);

    expect(frames[0]).toBe("early");
    expect(asBytes(frames[1])).toEqual([1]);
    expect(frames[2]).toBe("late");
    expect(left.a.bufferedAmount).toBe(0);
    link.close();
    await link.done;
  });

  it("holds frames from the other direction too (right opens first, left later)", async () => {
    const left = unopenedPortPair();
    const right = await portPair();
    relay(left.a, right.a);

    right.b.send("from right, early");
    await tick(30);
    const leftB = left.openPeer();
    const frames = received(leftB);
    await tick(50);

    expect(frames).toEqual(["from right, early"]);
  });

  it("closes both ends with 1011 when the destination closes before opening", async () => {
    const left = await portPair();
    const right = unopenedPortPair();
    const link = relay(left.b, right.a);
    const closedLeft = closeInfo(left.a);

    left.a.send("waiting");
    right.killPeer();

    const info = await closedLeft;
    expect(info.code).toBe(CLOSE_CODES.internalError);
    await link.done;
    expect(right.a.state).toBe("closed");
  });

  it("closes both ends with 1011 when a side is still connecting at the open deadline", async () => {
    const left = await portPair();
    const right = unopenedPortPair(); // Its peer port stays alive and never sends `open`.
    const link = relay(left.b, right.a, { openTimeoutMs: 60 });
    const closedLeft = closeInfo(left.a);

    left.a.send("waiting");

    const info = await closedLeft;
    expect(info.code).toBe(CLOSE_CODES.internalError);
    expect(info.reason).toContain("did not open within 60 ms");
    await link.done;
    expect(right.a.state).toBe("closed");
  });

  it("closes the other side at once when given a channel that is already closed", async () => {
    const left = await portPair();
    const right = await portPair();
    left.a.close(4001, "closed before the relay");
    await tick(20);
    expect(left.b.state).toBe("closed");
    const closedRight = closeInfo(right.b);

    const link = relay(left.b, right.a);

    const info = await closedRight;
    expect(info.code).toBe(CLOSE_CODES.internalError);
    expect(info.reason).toContain("already closed");
    await link.done;
  });

  it("propagates a custom close code from a side that was open when the relay was created, even in the same tick", async () => {
    const left = await portPair();
    const right = await portPair();
    const closedRight = closeInfo(right.b);
    const link = relay(left.a, right.a);

    left.a.close(4002, "intentional");

    const info = await closedRight;
    expect(info).toMatchObject({ code: 4002, reason: "intentional" });
    await link.done;
  });

  it("propagates a close issued inside the connecting side's own onOpen handler with its code", async () => {
    const source = unopenedPortPair();
    const right = await portPair();
    // Registered before the relay, so it runs first when the source opens, and closes synchronously.
    source.a.onOpen(() => source.a.close(4004, "closed inside onOpen"));
    const closedRight = closeInfo(right.b);
    const link = relay(source.a, right.a);

    const peer = source.openPeer();
    await opened(peer).catch(() => {});

    const info = await closedRight;
    expect(info).toMatchObject({ code: 4004, reason: "closed inside onOpen" });
    await link.done;
  });

  it("gives up with 1011 when more than maxPendingBytes is held for an unopened destination", async () => {
    const left = await portPair();
    const right = unopenedPortPair();
    const link = relay(left.b, right.a, { maxPendingBytes: 1024 });
    const closedLeft = closeInfo(left.a);

    left.a.send(new Uint8Array(1000));
    left.a.send(new Uint8Array(25));

    const info = await closedLeft;
    expect(info.code).toBe(CLOSE_CODES.internalError);
    expect(info.reason).toContain("had not opened");
    await link.done;
  });

  it("always holds the first frame for an unopened destination, however large", async () => {
    const left = await portPair();
    const right = unopenedPortPair();
    const link = relay(left.b, right.a, { maxPendingBytes: 1024 });
    const sizes: number[] = [];

    left.a.send(new Uint8Array(4096));
    const peer = right.openPeer();
    peer.onMessage((data) => {
      if (data instanceof Uint8Array) sizes.push(data.byteLength);
    });
    await opened(peer);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sizes).toEqual([4096]);
    expect(left.a.state).toBe("open");
    link.close();
    await link.done;
  });
});

describe("relay: WebSocket source to a slow port consumer", () => {
  it("pauses a ws socket so pending bytes stay bounded, and resumes when the consumer catches up", async () => {
    const maxPendingBytes = 64 * 1024;
    const windowBytes = 4096;
    const source = await webSocketPair({ maxPendingBytes });
    const destination = await portPair(windowBytes);
    const link = relay(source.b, destination.a);
    let delivered = 0;
    let consumed = 0;
    let maxInFlight = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    source.b.onMessage((data) => {
      delivered += frameBytes(data);
      maxInFlight = Math.max(maxInFlight, delivered - consumed);
    });
    destination.b.onMessage(async (data) => {
      await gate;
      consumed += frameBytes(data);
    });

    const frame = new Uint8Array(16 * 1024);
    for (let i = 0; i < 100; i++) source.a.send(frame);
    await tick(300);
    // Stalled consumer: the relay stopped reading the socket well before the 1.6 MB sent. What was
    // already read from the network when it paused (one socket chunk, 64 KiB) still comes through.
    const slack = 64 * 1024 + frame.byteLength;
    expect(delivered - consumed).toBeLessThanOrEqual(maxPendingBytes + slack);
    expect(source.a.state).toBe("open");

    release?.();
    await tick(500);
    expect(consumed).toBe(100 * frame.byteLength);
    expect(maxInFlight).toBeLessThanOrEqual(maxPendingBytes + slack);
    link.close();
    await link.done;
  });

  it("closes a socket that cannot pause with the overloaded code when the consumer falls too far behind", async () => {
    const maxPendingBytes = 8 * 1024;
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("The test server has no address");
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of server.clients) socket.terminate();
          server.close(() => resolve());
        }),
    );
    const accepted = new Promise<WebSocketLike>((resolve) => server.once("connection", (socket) => resolve(socket)));
    const sender = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const serverSocket = await accepted;
    // The server socket seen through the standard interface only: no pause/resume.
    const standardLike: WebSocketLike = {
      get readyState() {
        return serverSocket.readyState;
      },
      get bufferedAmount() {
        return serverSocket.bufferedAmount;
      },
      get binaryType() {
        return serverSocket.binaryType;
      },
      set binaryType(value: string) {
        serverSocket.binaryType = value;
      },
      send: (data) => serverSocket.send(data),
      close: (code, reason) => serverSocket.close(code, reason),
      addEventListener: serverSocket.addEventListener.bind(serverSocket),
      removeEventListener: serverSocket.removeEventListener.bind(serverSocket),
    };
    const receiver = channelFromWebSocket(standardLike, { maxPendingBytes });
    const closed = closeInfo(receiver);
    // What the overloaded sender is told.
    const senderClosed = new Promise<{ code: number; reason: string }>((resolve) =>
      sender.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true }),
    );
    receiver.onMessage(() => new Promise<void>(() => {}));
    await new Promise<void>((resolve) => sender.addEventListener("open", () => resolve(), { once: true }));

    for (let i = 0; i < 4; i++) sender.send(new Uint8Array(4 * 1024));

    expect((await closed).code).toBe(CLOSE_CODES.overloaded);
    const senderInfo = await senderClosed;
    expect(senderInfo.code).toBe(CLOSE_CODES.overloaded);
    expect(senderInfo.reason).toContain("behind");
  });
});

describe("WebSocket pending message count over a real socket", () => {
  it("closes a standard socket with 4008 behind a stuck consumer of empty messages, whatever the credit", async () => {
    const { a, b } = await webSocketPair({ maxPendingFrames: 100 }, { credit: true });
    // `a` is Node's standard WebSocket: it cannot pause. Empty messages never use up b's credit.
    a.onMessage(() => new Promise<void>(() => {}));
    const closed = closeInfo(a);
    const peerClosed = closeInfo(b);
    for (let i = 0; i < 1000 && b.state === "open"; i++) {
      await b.whenDrained();
      b.send("");
    }
    const info = await closed;
    expect(info.code).toBe(CLOSE_CODES.overloaded);
    expect(info.error).toBeInstanceOf(Error);
    expect(a.stats().overloadCloses).toBe(1);
    expect(await peerClosed).toMatchObject({
      code: CLOSE_CODES.overloaded,
      reason: expect.stringContaining("messages"),
    });
  });

  it("fails a credit ws socket at the count instead of hanging when handlers await their own drain", async () => {
    // An echo server: each (empty) request gets a 1 KiB reply, and its handler settles once the
    // reply was acknowledged. Pausing `b` would also stop the acknowledgements: a hang.
    const { a, b } = await webSocketPair(
      { maxPendingFrames: 100, lowWaterBytes: 0, credit: { windowBytes: 64 * 1024 } },
      { credit: true },
    );
    const reply = new Uint8Array(1024);
    b.onMessage(async () => {
      b.send(reply);
      await b.whenDrained();
    });
    const closed = closeInfo(b);
    const peerClosed = closeInfo(a);
    for (let i = 0; i < 2000; i++) a.send("");
    const info = await closed;
    expect(info.code).toBe(CLOSE_CODES.overloaded);
    expect(info.error).toBeInstanceOf(Error);
    expect(b.stats().overloadCloses).toBe(1);
    expect(await peerClosed).toMatchObject({ code: CLOSE_CODES.overloaded });
  });

  it("pauses a plain ws socket at the count and delivers everything once the consumer catches up", async () => {
    const maxPendingFrames = 100;
    const total = 30_000;
    // `b` is the server's ws socket (pausable); `a` sends empty messages without waiting.
    const { a, b } = await webSocketPair({ maxPendingFrames });
    const releases: (() => void)[] = [];
    let delivered = 0;
    b.onMessage(() => {
      delivered++;
      return new Promise<void>((resolve) => releases.push(resolve));
    });
    for (let i = 0; i < total; i++) a.send(new Uint8Array(0));
    await tick(300);
    // Paused at the count; what the socket had read when it paused (one 64 KiB chunk of 6-byte
    // masked frames, 10923) still came through, and nothing more.
    expect(delivered).toBeGreaterThanOrEqual(maxPendingFrames);
    expect(delivered).toBeLessThanOrEqual(maxPendingFrames + Math.ceil((64 * 1024) / 6));
    expect(b.state).toBe("open");

    const behind = () => delivered < total;
    for (let turns = 0; turns < 10_000 && behind(); turns++) {
      for (const release of releases.splice(0)) release();
      await tick(1);
    }
    expect(delivered).toBe(total);
    expect(b.stats()).toMatchObject({ framesReceived: total, overloadCloses: 0 });
  });
});

describe("WebSocket message size bound", () => {
  it("closes with messageTooBig (4009 on the wire) instead of delivering an oversized message", async () => {
    const { a, b } = await webSocketPair({ maxMessageBytes: 1024 });
    const frames = received(b);
    const closedA = closeInfo(a);
    const closedB = closeInfo(b);

    a.send(new Uint8Array(1025));

    const [infoA, infoB] = await Promise.all([closedA, closedB]);
    expect(frames).toEqual([]);
    // The far side (the sender) receives the code and reason; the closing side's own close event
    // echoes the peer's close frame, which carries the code only.
    expect(infoA.code).toBe(sendableCloseCode(CLOSE_CODES.messageTooBig));
    expect(infoA.code).toBe(4009);
    expect(infoA.reason).toContain("exceeds maxMessageBytes");
    expect(infoB.code).toBe(4009);
    expect(a.state).toBe("closed");
  });

  it("delivers messages at the limit", async () => {
    const { a, b } = await webSocketPair({ maxMessageBytes: 1024 });
    const frames = received(b);

    a.send(new Uint8Array(1024));
    await tick(50);

    expect(frames).toHaveLength(1);
    expect(b.state).toBe("open");
  });
});

describe("close reasons across a relay", () => {
  it("normalizeCloseReason keeps reasons within 123 UTF-8 bytes on a character boundary", () => {
    expect(normalizeCloseReason(undefined)).toBeUndefined();
    expect(normalizeCloseReason("short")).toBe("short");
    const ascii = "x".repeat(124);
    expect(normalizeCloseReason(ascii)).toBe("x".repeat(MAX_CLOSE_REASON_BYTES));
    const chinese = "\u9519".repeat(50); // 150 bytes
    const cut = normalizeCloseReason(chinese) ?? "";
    expect(new TextEncoder().encode(cut).byteLength).toBeLessThanOrEqual(MAX_CLOSE_REASON_BYTES);
    expect(cut).toBe("\u9519".repeat(41));
  });

  it.each([
    ["124 ASCII bytes", "x".repeat(124)],
    ["150 bytes of Chinese", "\u9519".repeat(50)],
  ])(
    "relays a port close with a %s reason onto a socket without throwing, and both ends finish",
    async (_name, reason) => {
      const left = await portPair();
      const right = await webSocketPair();
      const link = relay(left.b, right.a);
      const closedFar = closeInfo(right.b);

      left.a.close(4001, reason);

      const info = await closedFar;
      expect(info.code).toBe(4001);
      expect(reason.startsWith(info.reason ?? "")).toBe(true);
      expect(new TextEncoder().encode(info.reason ?? "").byteLength).toBeLessThanOrEqual(MAX_CLOSE_REASON_BYTES);
      await link.done;
      expect(right.a.state).toBe("closed");
      expect(left.b.state).toBe("closed");
    },
  );
});
