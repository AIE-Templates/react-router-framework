import { Socket } from "node:net";
import { MessageChannel } from "node:worker_threads";

// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket as WsSocket, WebSocketServer } from "ws";

import { type Channel, type ChannelCloseInfo, CLOSE_CODES, opened } from "./channel.ts";
import { channelFromPort, fromNodePort } from "./message-port.ts";
import { relay } from "./relay.ts";
import {
  channelFromWebSocket,
  CREDIT_SUBPROTOCOL,
  MAX_CONTROL_MESSAGE_BYTES,
  type WebSocketChannelOptions,
  type WebSocketLike,
} from "./web-socket.ts";

type Listener = (event: never) => void;

/** A socket the test drives by hand; `protocol` is what the handshake negotiated. */
class FakeSocket implements WebSocketLike {
  readyState = 1;
  bufferedAmount = 0;
  binaryType = "blob";
  protocol = CREDIT_SUBPROTOCOL;
  sent: (string | Uint8Array)[] = [];
  /**
   * Like a real socket, `close()` only starts the closing handshake (`CLOSING`, messages may still
   * arrive) and `finishClose()` completes it; otherwise `close()` completes at once.
   */
  closesLater = false;
  closeRequest: { code: number; reason: string } | undefined;
  readonly #listeners = new Map<string, Set<Listener>>();

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeRequest = { code: code ?? 1005, reason: reason ?? "" };
    if (this.closesLater) {
      this.readyState = 2;
      return;
    }
    this.finishClose();
  }

  finishClose(): void {
    this.readyState = 3;
    this.emit("close", this.closeRequest ?? { code: 1006, reason: "" });
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type)?.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) Reflect.apply(listener, undefined, [event]);
  }

  receive(data: string | Uint8Array): void {
    this.emit("message", { data });
  }

  /** The peer's `open` control message. */
  peerOpen(window: number, v = 1): void {
    this.receive(`\u0000${JSON.stringify({ t: "open", v, window })}`);
  }

  ack(bytes: number): void {
    this.receive(`\u0000${JSON.stringify({ t: "ack", bytes })}`);
  }

  /** Control messages sent so far, parsed. */
  controls(): { t: string; [key: string]: unknown }[] {
    return this.sent
      .filter((data): data is string => typeof data === "string" && data.startsWith("\u0000") && data[1] !== "\u0000")
      .map((data): { t: string } => {
        const value: unknown = JSON.parse(data.slice(1));
        if (typeof value !== "object" || value === null || typeof Reflect.get(value, "t") !== "string") {
          throw new Error(`Not a control message: ${data}`);
        }
        return { ...value, t: String(Reflect.get(value, "t")) };
      });
  }
}

function settled(promise: Promise<unknown>): () => boolean {
  let done = false;
  void promise.then(() => (done = true));
  return () => done;
}

function closeInfo(channel: Channel): Promise<ChannelCloseInfo> {
  return new Promise((resolve) => channel.onClose(resolve));
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("WebSocket credit: negotiation", () => {
  it("stays plain on a socket that did not negotiate the subprotocol, whatever the options", () => {
    const socket = new FakeSocket();
    socket.protocol = "";
    const channel = channelFromWebSocket(socket, { credit: { windowBytes: 1024 } });

    expect(channel.state).toBe("open");
    expect(socket.sent).toEqual([]);
    channel.send("\u0000raw");
    channel.send(new Uint8Array(4096));
    socket.bufferedAmount = 7;
    expect(socket.sent[0]).toBe("\u0000raw");
    expect(channel.bufferedAmount).toBe(7);

    const frames: unknown[] = [];
    channel.onMessage((data) => void frames.push(data));
    socket.receive('\u0000{"t":"ack","bytes":1}');
    expect(frames).toEqual(['\u0000{"t":"ack","bytes":1}']);
    expect(channel.stats().acksSent).toBe(0);
  });

  it("announces its window on an open socket and opens once the peer's open arrives", () => {
    const socket = new FakeSocket();
    const channel = channelFromWebSocket(socket, { credit: { windowBytes: 4096 } });
    const openedNow = vi.fn<() => void>();
    channel.onOpen(openedNow);

    expect(socket.controls()).toEqual([{ t: "open", v: 1, window: 4096 }]);
    expect(channel.state).toBe("connecting");
    expect(channel.everOpened).toBe(false);
    expect(() => channel.send("early")).toThrow("connecting");

    socket.peerOpen(8192);
    expect(channel.state).toBe("open");
    expect(channel.everOpened).toBe(true);
    expect(openedNow).toHaveBeenCalledOnce();
  });

  it("negotiates on a socket that opens later, reading the subprotocol at open", () => {
    const socket = new FakeSocket();
    socket.readyState = 0;
    socket.protocol = "";
    const channel = channelFromWebSocket(socket);
    expect(socket.sent).toEqual([]);

    socket.protocol = CREDIT_SUBPROTOCOL;
    socket.readyState = 1;
    socket.emit("open");
    expect(channel.state).toBe("connecting");
    expect(socket.controls()).toEqual([{ t: "open", v: 1, window: 1024 * 1024 }]);
    socket.peerOpen(1024);
    expect(channel.state).toBe("open");
  });

  it.each([
    ["data before open", (socket: FakeSocket) => socket.receive(new Uint8Array(1))],
    ["ack before open", (socket: FakeSocket) => socket.ack(1)],
    ["a control message is not JSON", (socket: FakeSocket) => socket.receive("\u0000{")],
    ["open: window must be a positive integer", (socket: FakeSocket) => socket.peerOpen(0)],
    ["the peer speaks credit v2, this side v1", (socket: FakeSocket) => socket.peerOpen(1024, 2)],
    [
      "a second open",
      (socket: FakeSocket) => {
        socket.peerOpen(1024);
        socket.peerOpen(1024);
      },
    ],
    [
      "ack: bytes must be a non-negative integer",
      (socket: FakeSocket) => {
        socket.peerOpen(1024);
        socket.receive('\u0000{"t":"ack","bytes":-1}');
      },
    ],
  ])("closes with a protocol error on %s", async (detail, act) => {
    const socket = new FakeSocket();
    const channel = channelFromWebSocket(socket);
    const closed = closeInfo(channel);

    act(socket);

    const info = await closed;
    expect(info).toMatchObject({ code: 4002, reason: `Protocol error: ${detail}` });
    // A failure, not a chosen close: a relay stops at once instead of following the peer's data.
    expect(info.error).toBeInstanceOf(Error);
    expect(info.error).toMatchObject({ message: `Protocol error: ${detail}` });
    expect(channel.stats().protocolErrors).toBe(1);
  });

  it("ignores control messages of an unknown type", () => {
    const socket = new FakeSocket();
    const channel = channelFromWebSocket(socket);
    socket.peerOpen(1024);
    socket.receive('\u0000{"t":"future","x":1}');
    expect(channel.state).toBe("open");
  });

  it("validates the credit options", () => {
    const socket = new FakeSocket();
    expect(() => channelFromWebSocket(socket, { credit: { windowBytes: 0 } })).toThrow(RangeError);
    expect(() => channelFromWebSocket(socket, { credit: { ackCoalesce: { frames: 0.5 } } })).toThrow(RangeError);
    expect(() => channelFromWebSocket(socket, { credit: { ackCoalesce: { delayMs: -1 } } })).toThrow(RangeError);
    expect(() => channelFromWebSocket(socket, { credit: JSON.parse("null") })).toThrow(TypeError);
    expect(socket.sent).toEqual([]);
  });
});

/** Sends `size`-byte messages while `whenDrained()` resolves at once; returns how many went out. */
async function sendWhileDrained(channel: Channel, size: number, max = 16): Promise<number> {
  let count = 0;
  while (count < max) {
    const drained = settled(channel.whenDrained());
    await Promise.resolve();
    if (!drained()) break;
    channel.send(new Uint8Array(size));
    count++;
  }
  return count;
}

const KiB = 1024;
const MiB = 1024 * KiB;

describe("WebSocket credit: sending", () => {
  it("counts what the peer has not acknowledged and wakes waiters on its acks, without timers", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const channel = channelFromWebSocket(socket, { lowWaterBytes: 512 * 1024 });
    socket.peerOpen(1000);

    channel.send(new Uint8Array(600));
    channel.send("é");
    expect(channel.bufferedAmount).toBe(602);
    const drained = settled(channel.whenDrained());
    expect(vi.getTimerCount()).toBe(0);

    // The low-water mark is half the peer's window when that is lower than lowWaterBytes.
    socket.ack(100);
    await vi.advanceTimersByTimeAsync(0);
    expect(drained()).toBe(false);
    socket.ack(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(drained()).toBe(true);
    expect(channel.bufferedAmount).toBe(500);

    socket.ack(10_000);
    expect(channel.bufferedAmount).toBe(0);
    expect(channel.stats()).toMatchObject({ acksReceived: 3, acksClamped: 1, framesSent: 2, bytesSent: 602 });
  });

  it.each([
    ["the default 1 MiB window, unset: half of it, as before", 1 * MiB, undefined, 512 * KiB],
    ["a 4 MiB window, unset: half of it", 4 * MiB, undefined, 2 * MiB],
    ["a 4 MiB window, a smaller explicit mark: the mark", 4 * MiB, 256 * KiB, 256 * KiB],
    ["a 4 MiB window, a larger explicit mark: capped at half the window", 4 * MiB, 3 * MiB, 2 * MiB],
    ["a 1 MiB window, the explicit old default: unchanged", 1 * MiB, 512 * KiB, 512 * KiB],
    ["a 64 KiB window, unset: half of it", 64 * KiB, undefined, 32 * KiB],
  ])("derives the low-water mark from the peer's window: %s", async (_, window, lowWaterBytes, mark) => {
    const socket = new FakeSocket();
    const channel = channelFromWebSocket(socket, lowWaterBytes === undefined ? {} : { lowWaterBytes });
    socket.peerOpen(window);

    channel.send(new Uint8Array(mark));
    await expect(channel.whenDrained()).resolves.toBeUndefined();
    channel.send(new Uint8Array(1));
    const drained = settled(channel.whenDrained());
    await Promise.resolve();
    expect(drained()).toBe(false);
    socket.ack(1);
    await Promise.resolve();
    expect(drained()).toBe(true);
  });

  it("treats an explicit undefined lowWaterBytes as unset", async () => {
    const socket = new FakeSocket();
    const channel = channelFromWebSocket(socket, { lowWaterBytes: undefined });
    socket.peerOpen(4 * MiB);
    expect(await sendWhileDrained(channel, MiB)).toBe(3);
  });

  it("keeps several large messages in flight when the peer enlarges its window and lowWaterBytes is unset", async () => {
    const socket = new FakeSocket();
    const channel = channelFromWebSocket(socket);
    socket.peerOpen(4 * MiB);

    // Drained at <= 2 MiB unacknowledged: three 1 MiB messages go out before the producer waits.
    expect(await sendWhileDrained(channel, MiB)).toBe(3);
    expect(channel.bufferedAmount).toBe(3 * MiB);
    socket.ack(MiB);
    expect(await sendWhileDrained(channel, MiB)).toBe(1);
  });

  it("keeps one large message in flight on the default window, as before", async () => {
    const socket = new FakeSocket();
    const channel = channelFromWebSocket(socket);
    socket.peerOpen(MiB);
    expect(await sendWhileDrained(channel, MiB)).toBe(1);
  });

  it("keeps the 512 KiB default in plain mode, whatever the credit options", async () => {
    const socket = new FakeSocket();
    socket.protocol = "";
    const channel = channelFromWebSocket(socket, { drainPollMs: 1, credit: { windowBytes: 4 * MiB } });
    socket.bufferedAmount = 512 * KiB;
    await expect(channel.whenDrained()).resolves.toBeUndefined();
    socket.bufferedAmount = 512 * KiB + 1;
    const drained = settled(channel.whenDrained());
    await tick(10);
    expect(drained()).toBe(false);
    socket.bufferedAmount = 512 * KiB;
    await tick(10);
    expect(drained()).toBe(true);
    channel.close();
  });

  it("escapes application strings that start with U+0000 and unescapes them on receipt", () => {
    const socket = new FakeSocket();
    const channel = channelFromWebSocket(socket);
    socket.peerOpen(1024);
    const frames: unknown[] = [];
    channel.onMessage((data) => void frames.push(data));

    channel.send("\u0000app");
    expect(socket.sent.at(-1)).toBe("\u0000\u0000app");
    expect(channel.bufferedAmount).toBe(4);

    socket.receive("\u0000\u0000app");
    socket.receive("plain");
    expect(frames).toEqual(["\u0000app", "plain"]);
    expect(channel.stats().bytesReceived).toBe(9);
  });

  it("releases credit waiters and clears the ack timer when the socket closes", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const channel = channelFromWebSocket(socket);
    socket.peerOpen(100);
    channel.onMessage(() => {});
    socket.receive(new Uint8Array(1));
    expect(vi.getTimerCount()).toBe(1);
    channel.send(new Uint8Array(1000));
    const drained = settled(channel.whenDrained());

    socket.emit("close", { code: 1006, reason: "" });
    await vi.advanceTimersByTimeAsync(0);

    expect(drained()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(channel.bufferedAmount).toBe(0);
    await expect(channel.whenDrained()).resolves.toBeUndefined();
  });
});

describe("WebSocket credit: acknowledging", () => {
  it("acknowledges a message only once every handler settled", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const channel = channelFromWebSocket(socket, { credit: { ackCoalesce: { bytes: 1, delayMs: 0 } } });
    socket.peerOpen(1024);
    const releases: (() => void)[] = [];
    channel.onMessage(() => new Promise<void>((resolve) => releases.push(resolve)));
    channel.onMessage(() => {});

    socket.receive(new Uint8Array(10));
    await vi.advanceTimersByTimeAsync(5);
    expect(socket.controls().filter((c) => c.t === "ack")).toEqual([]);
    expect(channel.stats().heldBytes).toBe(10);

    for (const release of releases) release();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.controls().filter((c) => c.t === "ack")).toEqual([{ t: "ack", bytes: 10 }]);
    expect(channel.stats().heldBytes).toBe(0);
  });

  it("coalesces acknowledgements by bytes, by frames and by delay", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const channel = channelFromWebSocket(socket, {
      credit: { windowBytes: 4096, ackCoalesce: { bytes: 100, frames: 3, delayMs: 2 } },
    });
    socket.peerOpen(4096);
    channel.onMessage(() => {});
    const acks = () => socket.controls().filter((c) => c.t === "ack");

    socket.receive(new Uint8Array(60));
    socket.receive(new Uint8Array(60)); // 120 bytes: flush by bytes
    expect(acks()).toEqual([{ t: "ack", bytes: 120 }]);

    socket.receive("a");
    socket.receive("b");
    socket.receive("c"); // 3 frames: flush by frames
    expect(acks()).toHaveLength(2);
    expect(acks()[1]).toEqual({ t: "ack", bytes: 3 });

    socket.receive("tail");
    expect(acks()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2); // the tail goes out after the delay
    expect(acks()[2]).toEqual({ t: "ack", bytes: 4 });
    expect(channel.stats()).toMatchObject({ acksSent: 3, acksCoalesced: 3, heldBytes: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * A pair over a local `ws` server that selects the credit subprotocol when offered (`serverCredit`).
 * The client is Node's standard `WebSocket` (cannot pause, like a browser) or a `ws` client.
 */
async function creditPair({
  client = "standard",
  offer = true,
  serverCredit = true,
  options = {},
}: {
  client?: "standard" | "ws";
  offer?: boolean;
  serverCredit?: boolean;
  options?: WebSocketChannelOptions;
} = {}): Promise<{ a: Channel; b: Channel; breakB: () => void }> {
  const server = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    handleProtocols: (protocols) => (serverCredit && protocols.has(CREDIT_SUBPROTOCOL) ? CREDIT_SUBPROTOCOL : false),
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("The test server has no address");
  const serverSocket = new Promise<WebSocketLike>((resolve) => server.once("connection", (socket) => resolve(socket)));
  const url = `ws://127.0.0.1:${address.port}`;
  const protocols = offer ? [CREDIT_SUBPROTOCOL] : [];
  const a = channelFromWebSocket(
    client === "ws" ? new WsSocket(url, protocols) : new WebSocket(url, protocols),
    client === "ws" ? { ...options, sendWithCallback: true } : options,
  );
  const b = channelFromWebSocket(await serverSocket, { ...options, sendWithCallback: true });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        a.close();
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

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** Produces 8 KiB messages into a consumer that never finishes, honouring `whenDrained()`. */
async function produceIntoStuckConsumer(offer: boolean): Promise<{ a: Channel; b: Channel; sent: number }> {
  const { a, b } = await creditPair({
    offer,
    options: { maxPendingBytes: 64 * 1024, credit: { windowBytes: 64 * 1024 } },
  });
  a.onMessage(() => new Promise<void>(() => {}));
  let sent = 0;
  for (let i = 0; i < 32 && b.state === "open"; i++) {
    const drained = await Promise.race([b.whenDrained().then(() => true), tick(50).then(() => false)]);
    if (!drained || b.state !== "open") break;
    b.send(new Uint8Array(8 * 1024));
    sent += 8 * 1024;
  }
  await tick(50);
  return { a, b, sent };
}

describe("WebSocket credit over a real socket", () => {
  it.each(["standard", "ws"] as const)(
    "a slow %s consumer stops the producer within the window, then lets it go on",
    async (client) => {
      const windowBytes = 64 * 1024;
      const frame = 8 * 1024;
      const { a, b } = await creditPair({ client, options: { credit: { windowBytes } } });
      // The server produces into the client, which holds every message until released.
      const releases: (() => void)[] = [];
      let consumed = 0;
      a.onMessage(
        (data) =>
          new Promise<void>((resolve) =>
            releases.push(() => {
              consumed += typeof data === "string" ? data.length : data.byteLength;
              resolve();
            }),
          ),
      );
      let sent = 0;
      let maxOutstanding = 0;
      const total = 1024 * 1024;
      const producing = (async () => {
        while (sent < total && b.state === "open") {
          await b.whenDrained();
          b.send(new Uint8Array(frame));
          sent += frame;
          maxOutstanding = Math.max(maxOutstanding, b.bufferedAmount);
        }
      })();

      await tick(100);
      // Stopped by credit, not by socket buffers: the 1 MiB never left the producer.
      expect(sent).toBeLessThanOrEqual(windowBytes / 2 + frame);
      expect(b.bufferedAmount).toBe(sent);
      expect(a.stats().heldBytes).toBe(sent);
      expect(a.state).toBe("open");

      const remaining = () => total - consumed;
      for (let turns = 0; turns < 10_000 && remaining() > 0; turns++) {
        for (const release of releases.splice(0)) release();
        await tick(1);
      }
      expect(consumed).toBe(total);
      await producing;
      expect(maxOutstanding).toBeLessThanOrEqual(windowBytes / 2 + frame);
      await tick(20);
      expect(b.bufferedAmount).toBe(0);
      expect(a.stats().overloadCloses).toBe(0);
      expect(b.stats().acksReceived).toBeGreaterThan(0);
    },
  );

  it("lets a producer keep several 1 MiB messages in flight against a 4 MiB window", async () => {
    const { a, b } = await creditPair({ client: "ws", options: { credit: { windowBytes: 4 * 1024 * 1024 } } });
    const releases: (() => void)[] = [];
    a.onMessage(() => new Promise<void>((resolve) => releases.push(resolve)));
    let sent = 0;
    for (let i = 0; i < 8; i++) {
      const drained = await Promise.race([b.whenDrained().then(() => true), tick(50).then(() => false)]);
      if (!drained) break;
      b.send(new Uint8Array(1024 * 1024));
      sent++;
    }
    // Low water at half the window (2 MiB): three messages before the producer waits, not one.
    expect(sent).toBe(3);
    expect(b.bufferedAmount).toBe(3 * 1024 * 1024);
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    for (const release of releases.splice(0)) release();
    await vi.waitFor(() => expect(b.bufferedAmount).toBe(0));
  });

  it("keeps a standard (browser-like) socket open behind a stuck consumer by stopping the producer", async () => {
    const { a, b, sent } = await produceIntoStuckConsumer(true);
    expect(a.state).toBe("open");
    expect(sent).toBeLessThanOrEqual(32 * 1024 + 8 * 1024);
    expect(b.bufferedAmount).toBe(sent);
  });

  it("without credit, the same standard socket is closed as overloaded", async () => {
    const { a } = await produceIntoStuckConsumer(false);
    expect(a.state).toBe("closed");
    expect(a.stats().overloadCloses).toBe(1);
  });

  it("stays plain when the client does not offer the subprotocol, even if both sides pass credit", async () => {
    const { a, b } = await creditPair({ offer: false, options: { credit: { windowBytes: 1024 } } });
    const toB: unknown[] = [];
    const toA: unknown[] = [];
    b.onMessage((data) => void toB.push(data));
    a.onMessage((data) => void toA.push(data));
    a.send("\u0000raw");
    b.send(new Uint8Array(4096));
    await tick(50);
    expect(toB).toEqual(["\u0000raw"]);
    expect(toA).toHaveLength(1);
    expect(a.stats().acksSent + b.stats().acksSent).toBe(0);
  });

  it.each(["standard", "ws"] as const)(
    "fails the handshake when a %s client offers it to a server that declines (no silent mismatch)",
    async (client) => {
      await expect(creditPair({ client, serverCredit: false })).rejects.toThrow(/./);
    },
  );

  it("carries control-looking strings and close codes in credit mode", async () => {
    const { a, b } = await creditPair({ client: "ws" });
    const toB: unknown[] = [];
    b.onMessage((data) => void toB.push(data));
    a.send('\u0000{"t":"ack","bytes":1}');
    a.send("x");
    await tick(50);
    expect(toB).toEqual(['\u0000{"t":"ack","bytes":1}', "x"]);
    expect(a.stats().acksClamped + b.stats().acksClamped).toBe(0);

    const closed = closeInfo(b);
    a.close(4001, "done");
    expect(await closed).toMatchObject({ code: 4001, reason: "done" });
  });

  it("releases a producer waiting for credit when the consumer's transport drops", async () => {
    const { a, b, breakB } = await creditPair({ client: "ws", options: { credit: { windowBytes: 1024 } } });
    b.onMessage(() => new Promise<void>(() => {}));
    a.send(new Uint8Array(4096));
    const drained = settled(a.whenDrained());
    await tick(20);
    expect(drained()).toBe(false);

    const closed = closeInfo(a);
    breakB();
    expect((await closed).code).toBe(CLOSE_CODES.abnormal);
    await tick(0);
    expect(drained()).toBe(true);
    expect(a.bufferedAmount).toBe(0);
  });
});

/** What the test servers receive: whether it is the client's credit `open`. */
function isOpenControl(data: unknown): boolean {
  return Buffer.isBuffer(data) && data.toString("utf8").startsWith('\u0000{"t":"open"');
}

describe("WebSocket credit: termination", () => {
  it("does not open on a peer open that arrives after a local close", async () => {
    const socket = new FakeSocket();
    socket.closesLater = true;
    const channel = channelFromWebSocket(socket);
    const onOpen = vi.fn<() => void>();
    channel.onOpen(onOpen);
    const opening = opened(channel);
    const rejected = opening.then(
      () => false,
      () => true,
    );

    channel.close(1000, "cancelled");
    expect(channel.state).toBe("closing");
    socket.peerOpen(1024);
    // Data and acks of the session that never started are ignored, not protocol errors.
    socket.ack(0);
    socket.receive("late");
    expect(onOpen).not.toHaveBeenCalled();
    expect(channel.everOpened).toBe(false);
    expect(channel.state).toBe("closing");

    socket.finishClose();
    expect(await rejected).toBe(true);
    expect(channel.stats().protocolErrors).toBe(0);
  });

  it("does not open on a peer open that arrives while the socket is closing", () => {
    const socket = new FakeSocket();
    const channel = channelFromWebSocket(socket);
    const onOpen = vi.fn<() => void>();
    channel.onOpen(onOpen);
    socket.readyState = 2; // The peer started the close.
    socket.peerOpen(1024);
    expect(onOpen).not.toHaveBeenCalled();
    expect(channel.everOpened).toBe(false);
  });

  it("stops processing everything received after a protocol error and reports it as the close's error", async () => {
    const socket = new FakeSocket();
    socket.closesLater = true;
    const channel = channelFromWebSocket(socket, { credit: { ackCoalesce: { frames: 1 } } });
    const received: unknown[] = [];
    channel.onMessage((data) => void received.push(data));
    const closed = closeInfo(channel);
    socket.peerOpen(1024);
    socket.receive("before");
    socket.receive("\u0000{");
    // The socket is closing, and may still deliver what the peer sent before it saw the close.
    socket.receive("after");
    socket.receive(new Uint8Array(4));
    socket.ack(0);
    socket.peerOpen(1024);

    expect(received).toEqual(["before"]);
    expect(channel.stats()).toMatchObject({ framesReceived: 1, protocolErrors: 1, acksReceived: 0, acksSent: 1 });
    expect(socket.closeRequest).toEqual({ code: 4002, reason: "Protocol error: a control message is not JSON" });
    socket.finishClose();
    const info = await closed;
    expect(info.code).toBe(4002);
    expect(info.error).toBeInstanceOf(Error);
  });

  it("still delivers what arrives during a graceful close, in credit and in plain mode", () => {
    for (const protocol of [CREDIT_SUBPROTOCOL, ""]) {
      const socket = new FakeSocket();
      socket.protocol = protocol;
      socket.closesLater = true;
      const channel = channelFromWebSocket(socket);
      const received: unknown[] = [];
      channel.onMessage((data) => void received.push(data));
      if (protocol) socket.peerOpen(1024);
      channel.close(1000);
      socket.receive("in flight");
      expect(received).toEqual(["in flight"]);
    }
  });

  it("has a relay drop what follows a protocol error and close the other side at once", async () => {
    const socket = new FakeSocket();
    socket.closesLater = true;
    const ws = channelFromWebSocket(socket);
    socket.peerOpen(1024);
    const { port1, port2 } = new MessageChannel();
    const near = channelFromPort(fromNodePort(port1));
    const far = channelFromPort(fromNodePort(port2));
    cleanups.push(() => {
      near.close();
      far.close();
    });
    await Promise.all([opened(near), opened(far)]);
    const link = relay(ws, near);
    const toFar: unknown[] = [];
    far.onMessage((data) => void toFar.push(data));
    const farClosed = closeInfo(far);

    socket.receive("ok");
    socket.receive('\u0000{"t":"ack"}');
    socket.receive("must not cross");
    socket.finishClose();

    expect(await farClosed).toMatchObject({ code: 4002 });
    await link.done;
    expect(toFar).toEqual(["ok"]);
  });

  it.each(["standard", "ws"] as const)(
    "a %s client that closes before the server's open arrives never reports open",
    async (client) => {
      const server = new WebSocketServer({
        port: 0,
        host: "127.0.0.1",
        handleProtocols: (protocols) => (protocols.has(CREDIT_SUBPROTOCOL) ? CREDIT_SUBPROTOCOL : false),
      });
      await new Promise<void>((resolve) => server.once("listening", resolve));
      cleanups.push(
        () =>
          new Promise<void>((resolve) => {
            for (const peer of server.clients) peer.terminate();
            server.close(() => resolve());
          }),
      );
      // The server answers the client's open, so its open arrives after the client's socket opened.
      server.on("connection", (peer) =>
        peer.on("message", (data, isBinary) => {
          if (!isBinary && isOpenControl(data)) {
            peer.send(`\u0000${JSON.stringify({ t: "open", v: 1, window: 1024 })}`);
          }
        }),
      );
      const address = server.address();
      if (typeof address !== "object" || address === null) throw new Error("no address");
      const url = `ws://127.0.0.1:${address.port}`;
      const socket =
        client === "ws" ? new WsSocket(url, [CREDIT_SUBPROTOCOL]) : new WebSocket(url, [CREDIT_SUBPROTOCOL]);
      const channel = channelFromWebSocket(socket);
      const onOpen = vi.fn<() => void>();
      channel.onOpen(onOpen);
      const opening = opened(channel).then(
        () => "resolved",
        () => "rejected",
      );
      socket.addEventListener("open", () => channel.close(1000, "cancel"));
      const closed = await closeInfo(channel);

      expect(closed.code).toBe(1000);
      expect(await opening).toBe("rejected");
      expect(onOpen).not.toHaveBeenCalled();
    },
  );

  it("stops delivering at a malformed control message that shares a network write with the data after it", async () => {
    const server = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      handleProtocols: (protocols) => (protocols.has(CREDIT_SUBPROTOCOL) ? CREDIT_SUBPROTOCOL : false),
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const peer of server.clients) peer.terminate();
          server.close(() => resolve());
        }),
    );
    server.on("connection", (peer) =>
      peer.on("message", (data, isBinary) => {
        if (isBinary || !isOpenControl(data)) return;
        // One write: open, a malformed control message, then two application messages.
        const raw: unknown = Reflect.get(peer, "_socket");
        if (!(raw instanceof Socket)) throw new Error("ws has no underlying socket");
        raw.cork();
        peer.send(`\u0000${JSON.stringify({ t: "open", v: 1, window: 1024 })}`);
        peer.send("\u0000{");
        peer.send("must not run");
        peer.send("nor this");
        raw.uncork();
      }),
    );
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    const channel = channelFromWebSocket(new WsSocket(`ws://127.0.0.1:${address.port}`, [CREDIT_SUBPROTOCOL]));
    const received: unknown[] = [];
    channel.onMessage((data) => void received.push(data));
    const info = await closeInfo(channel);

    expect(info.code).toBe(4002);
    expect(info.error).toBeInstanceOf(Error);
    expect(received).toEqual([]);
    expect(channel.stats().framesReceived).toBe(0);
  });
});

describe("WebSocket: local limit closes are failures", () => {
  it.each([CREDIT_SUBPROTOCOL, ""])(
    "stops delivering after a message over maxMessageBytes and reports 4009 with an error (protocol %j)",
    async (protocol) => {
      const socket = new FakeSocket();
      socket.protocol = protocol;
      socket.closesLater = true;
      const channel = channelFromWebSocket(socket, { maxMessageBytes: 1 });
      const received: unknown[] = [];
      channel.onMessage((data) => void received.push(data));
      const closed = closeInfo(channel);
      if (protocol) socket.peerOpen(1024);
      socket.receive("a");
      socket.receive("xx");
      // Still handed over while the socket closes: neither delivered nor acknowledged.
      socket.receive("q");
      socket.ack(0);
      expect(received).toEqual(["a"]);
      expect(socket.closeRequest).toEqual({ code: 4009, reason: "A 2-byte message exceeds maxMessageBytes (1)" });
      await tick(10);
      // The 1 ms ack timer for "a" was stopped by the failure.
      expect(socket.controls().filter((control) => control.t === "ack")).toEqual([]);
      socket.finishClose();
      const info = await closed;
      expect(info.code).toBe(4009);
      expect(info.error).toBeInstanceOf(Error);
      expect(channel.stats()).toMatchObject({ framesReceived: 2, acksReceived: 0 });
    },
  );

  it("stops delivering after the overload close and reports 4008 with an error", async () => {
    const socket = new FakeSocket();
    socket.protocol = "";
    socket.closesLater = true;
    const channel = channelFromWebSocket(socket, { maxPendingBytes: 2 });
    const received: unknown[] = [];
    channel.onMessage((data) => {
      received.push(data);
      return new Promise<void>(() => {});
    });
    const closed = closeInfo(channel);
    socket.receive("a");
    socket.receive("bc");
    socket.receive("late");
    expect(received).toEqual(["a", "bc"]);
    expect(socket.closeRequest).toEqual({ code: 4008, reason: "Receiver fell 3 bytes behind, more than 2" });
    socket.finishClose();
    const info = await closed;
    expect(info.code).toBe(4008);
    expect(info.error).toBeInstanceOf(Error);
    expect(channel.stats()).toMatchObject({ overloadCloses: 1, protocolErrors: 0 });
  });

  it("resumes a paused socket when it fails, so the close handshake can complete", () => {
    const socket = new FakeSocket();
    socket.protocol = "";
    socket.closesLater = true;
    const pause = vi.fn<() => void>();
    const resume = vi.fn<() => void>();
    Object.assign(socket, { pause, resume });
    const channel = channelFromWebSocket(socket, { maxPendingBytes: 2, maxMessageBytes: 4 });
    channel.onMessage(() => new Promise<void>(() => {}));
    socket.receive("ab");
    expect(pause).toHaveBeenCalledOnce();
    // What the socket had already read when it paused still arrives.
    socket.receive("too long");
    expect(socket.closeRequest?.code).toBe(4009);
    expect(resume).toHaveBeenCalledOnce();
  });

  it("has a relay finish at once after a local overload close, though the destination's consumer is stuck", async () => {
    const socket = new FakeSocket();
    socket.protocol = "";
    socket.closesLater = true;
    const ws = channelFromWebSocket(socket, { maxPendingBytes: 4 });
    const { port1, port2 } = new MessageChannel();
    const near = channelFromPort(fromNodePort(port1), { windowBytes: 2, lowWaterBytes: 0 });
    const far = channelFromPort(fromNodePort(port2), { windowBytes: 2, lowWaterBytes: 0 });
    cleanups.push(() => {
      near.close();
      far.close();
    });
    await Promise.all([opened(near), opened(far)]);
    far.onMessage(() => new Promise<void>(() => {}));
    const link = relay(ws, near);
    const farClosed = closeInfo(far);

    // The first fills the destination; the rest wait in the relay, pending on the socket channel.
    for (const message of ["xx", "y", "z", "w"]) socket.receive(message);
    expect(socket.closeRequest?.code).toBe(4008);
    // "y" and "z" are queued in the relay; "w" arrived after the failure and was dropped.
    expect(link.stats().aToB.heldBytes).toBe(2);
    socket.finishClose();

    expect(await farClosed).toMatchObject({ code: 4008 });
    await link.done;
    expect(link.stats().aToB.heldBytes).toBe(0);
  });

  it("has a relay finish at once after a local 4009", async () => {
    const socket = new FakeSocket();
    socket.protocol = "";
    socket.closesLater = true;
    const ws = channelFromWebSocket(socket, { maxMessageBytes: 2 });
    const { port1, port2 } = new MessageChannel();
    const near = channelFromPort(fromNodePort(port1), { windowBytes: 2, lowWaterBytes: 0 });
    const far = channelFromPort(fromNodePort(port2), { windowBytes: 2, lowWaterBytes: 0 });
    cleanups.push(() => {
      near.close();
      far.close();
    });
    await Promise.all([opened(near), opened(far)]);
    const toFar: unknown[] = [];
    far.onMessage((data) => {
      toFar.push(data);
      return new Promise<void>(() => {});
    });
    const link = relay(ws, near);
    const farClosed = closeInfo(far);
    for (const message of ["ab", "c", "toolong", "d"]) socket.receive(message);
    socket.finishClose();

    expect(await farClosed).toMatchObject({ code: 4009 });
    await link.done;
    expect(toFar).toEqual(["ab"]);
    expect(link.stats().aToB.heldBytes).toBe(0);
  });
});

/** A standard (cannot pause) socket in `protocol` mode whose receiver never settles a handler. */
function stuckReceiver(protocol: string, options: WebSocketChannelOptions) {
  const socket = new FakeSocket();
  socket.protocol = protocol;
  socket.closesLater = true;
  const channel = channelFromWebSocket(socket, options);
  const received: unknown[] = [];
  channel.onMessage((data) => {
    received.push(data);
    return new Promise<void>(() => {});
  });
  if (protocol) socket.peerOpen(1024);
  return { socket, channel, received };
}

describe("WebSocket: pending message count bound", () => {
  it.each([CREDIT_SUBPROTOCOL, ""])(
    "fails a socket that cannot pause with 4008 and an error at maxPendingFrames empty messages (protocol %j)",
    async (protocol) => {
      const { socket, channel, received } = stuckReceiver(protocol, { maxPendingFrames: 3 });
      const closed = closeInfo(channel);
      socket.receive("");
      socket.receive(new Uint8Array(0));
      expect(socket.closeRequest).toBeUndefined();
      socket.receive("");
      expect(socket.closeRequest).toEqual({
        code: 4008,
        reason: "Receiver fell 3 messages behind (maxPendingFrames 3)",
      });
      // Handed over while the socket closes: not delivered, like after the byte bound.
      socket.receive("");
      expect(received).toHaveLength(3);
      socket.finishClose();
      const info = await closed;
      expect(info.code).toBe(4008);
      expect(info.error).toBeInstanceOf(Error);
      expect(channel.stats()).toMatchObject({ overloadCloses: 1, protocolErrors: 0, heldBytes: 0 });
    },
  );

  it("pauses a pausable socket in plain mode at the count and resumes once both counts are at half", async () => {
    const socket = new FakeSocket();
    socket.protocol = "";
    const pause = vi.fn<() => void>();
    const resume = vi.fn<() => void>();
    Object.assign(socket, { pause, resume });
    const channel = channelFromWebSocket(socket, { maxPendingFrames: 4 });
    const releases: (() => void)[] = [];
    channel.onMessage(() => new Promise<void>((resolve) => releases.push(resolve)));
    for (let i = 0; i < 3; i++) socket.receive("");
    expect(pause).not.toHaveBeenCalled();
    socket.receive("");
    expect(pause).toHaveBeenCalledOnce();
    // What the socket had already read still arrives, and is delivered.
    socket.receive("");
    expect(releases).toHaveLength(5);
    expect(channel.state).toBe("open");

    // 5 pending: releasing 2 leaves 3, above half of 4; one more reaches 2.
    for (const release of releases.splice(0, 2)) release();
    await tick(0);
    expect(resume).not.toHaveBeenCalled();
    releases.shift()?.();
    await tick(0);
    expect(resume).toHaveBeenCalledOnce();
    expect(channel.stats().overloadCloses).toBe(0);
  });

  it("fails a pausable socket in credit mode at the count instead of pausing it", async () => {
    const socket = new FakeSocket();
    socket.closesLater = true;
    const pause = vi.fn<() => void>();
    const resume = vi.fn<() => void>();
    Object.assign(socket, { pause, resume });
    const channel = channelFromWebSocket(socket, { maxPendingFrames: 3 });
    const received: unknown[] = [];
    channel.onMessage((data) => {
      received.push(data);
      return new Promise<void>(() => {});
    });
    const closed = closeInfo(channel);
    socket.peerOpen(1024);
    for (let i = 0; i < 4; i++) socket.receive("");
    expect(pause).not.toHaveBeenCalled();
    expect(socket.closeRequest).toEqual({ code: 4008, reason: "Receiver fell 3 messages behind (maxPendingFrames 3)" });
    expect(received).toHaveLength(3);
    expect(channel.stats()).toMatchObject({ heldFrames: 3, heldBytes: 0 });
    socket.finishClose();
    const info = await closed;
    expect(info.code).toBe(4008);
    expect(info.error).toBeInstanceOf(Error);
    expect(channel.stats().overloadCloses).toBe(1);
  });

  it("fails a credit-mode socket paused for bytes once the count is reached too", () => {
    const socket = new FakeSocket();
    socket.closesLater = true;
    const pause = vi.fn<() => void>();
    const resume = vi.fn<() => void>();
    Object.assign(socket, { pause, resume });
    const channel = channelFromWebSocket(socket, {
      maxPendingBytes: 2,
      maxPendingFrames: 3,
      credit: { windowBytes: 1 },
    });
    channel.onMessage(() => new Promise<void>(() => {}));
    socket.peerOpen(1024);
    // A peer ignoring its 1-byte credit: 2 bytes were pending ahead of "c", so the socket pauses.
    socket.receive("ab");
    socket.receive("c");
    expect(pause).toHaveBeenCalledOnce();
    expect(socket.closeRequest).toBeUndefined();
    // Read before the pause took effect: the third pending message fails the channel.
    socket.receive("");
    expect(socket.closeRequest?.code).toBe(4008);
    expect(resume).toHaveBeenCalledOnce();
    expect(channel.stats().overloadCloses).toBe(1);
  });

  it("releases the count as handlers settle, so a slow consumer that catches up is never closed", async () => {
    const socket = new FakeSocket();
    socket.protocol = "";
    const channel = channelFromWebSocket(socket, { maxPendingFrames: 3 });
    const releases: (() => void)[] = [];
    channel.onMessage(() => new Promise<void>((resolve) => releases.push(resolve)));
    for (let i = 0; i < 100; i++) {
      socket.receive("");
      socket.receive("");
      for (const release of releases.splice(0)) release();
      await tick(0);
    }
    expect(channel.state).toBe("open");
    expect(channel.stats()).toMatchObject({ framesReceived: 200, overloadCloses: 0 });
  });

  it("leaves non-empty traffic to the byte bound under the default", () => {
    const { socket, channel } = stuckReceiver("", {});
    // 16384 pending 32-byte messages: 512 KiB, under both default bounds.
    const message = new Uint8Array(32);
    for (let i = 0; i < 16_384; i++) socket.receive(message);
    expect(channel.state).toBe("open");
    expect(channel.stats()).toMatchObject({ heldBytes: 512 * 1024, overloadCloses: 0 });
  });
});

/** A control message of exactly `bytes` (ASCII), padded with an extra field. */
function padded(fields: object, bytes: number): string {
  const base = `\u0000${JSON.stringify({ ...fields, pad: "" })}`;
  return `\u0000${JSON.stringify({ ...fields, pad: "x".repeat(bytes - base.length) })}`;
}

describe("WebSocket credit: control message limit", () => {
  it.each([
    ["an unknown control message before open", false, { t: "future" }],
    ["an open", false, { t: "open", v: 1, window: 1024 }],
    ["an unknown control message after open", true, { t: "future" }],
    ["an ack", true, { t: "ack", bytes: 0 }],
  ])("fails on %s over the limit, before parsing it", (_name, open, fields) => {
    const socket = new FakeSocket();
    const channel = channelFromWebSocket(socket);
    if (open) socket.peerOpen(1024);
    const parse = vi.spyOn(JSON, "parse");
    socket.receive(padded(fields, MAX_CONTROL_MESSAGE_BYTES + 1));
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
    expect(channel.state).toBe("closed");
    expect(socket.closeRequest).toEqual({
      code: 4002,
      reason: `Protocol error: a control message over ${MAX_CONTROL_MESSAGE_BYTES} bytes`,
    });
  });

  it("accepts a control message of exactly the limit, and counts UTF-8 bytes, not characters", () => {
    const socket = new FakeSocket();
    const channel = channelFromWebSocket(socket);
    socket.receive(padded({ t: "future" }, MAX_CONTROL_MESSAGE_BYTES));
    socket.peerOpen(1024);
    expect(channel.state).toBe("open");
    // 600 two-byte characters: under the limit in UTF-16 units, over it in bytes.
    socket.receive(`\u0000${JSON.stringify({ t: "future", pad: "é".repeat(600) })}`);
    expect(channel.state).toBe("closed");
    expect(channel.stats().protocolErrors).toBe(1);
  });

  it("does not apply the application's maxMessageBytes to control messages", async () => {
    const socket = new FakeSocket();
    const channel = channelFromWebSocket(socket, { maxMessageBytes: 1, credit: { ackCoalesce: { frames: 1 } } });
    channel.onMessage(() => {});
    socket.peerOpen(1024);
    expect(channel.state).toBe("open");
    socket.receive("x");
    expect(socket.controls().map((control) => control.t)).toEqual(["open", "ack"]);
    socket.ack(0);
    expect(channel.state).toBe("open");
    socket.receive("xy");
    expect(socket.closeRequest?.code).toBe(4009);

    // Over a real socket too, with a one-byte application limit on both ends.
    const { a, b } = await creditPair({ options: { maxMessageBytes: 1 } });
    const toB: unknown[] = [];
    b.onMessage((data) => void toB.push(data));
    a.send("z");
    await tick(30);
    expect(toB).toEqual(["z"]);
    expect(a.bufferedAmount).toBe(0);
  });

  it("closes a standard socket that receives an oversized control message, whatever maxMessageBytes says", async () => {
    const server = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      handleProtocols: (protocols) => (protocols.has(CREDIT_SUBPROTOCOL) ? CREDIT_SUBPROTOCOL : false),
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const peer of server.clients) peer.terminate();
          server.close(() => resolve());
        }),
    );
    server.on("connection", (peer) => {
      peer.send(`\u0000${JSON.stringify({ t: "open", v: 1, window: 1024 * 1024 })}`);
      peer.send(`\u0000${JSON.stringify({ t: "future", pad: "x".repeat(32 * 1024) })}`);
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    const channel = channelFromWebSocket(new WebSocket(`ws://127.0.0.1:${address.port}`, [CREDIT_SUBPROTOCOL]), {
      maxMessageBytes: 64 * 1024,
    });
    const info = await closeInfo(channel);
    expect(info.code).toBe(4002);
    expect(info.reason).toBe(`Protocol error: a control message over ${MAX_CONTROL_MESSAGE_BYTES} bytes`);
    expect(channel.stats().framesReceived).toBe(0);
  });
});

describe("WebSocket credit: overload rule", () => {
  it("lets a sender that waited for drain send one message larger than the window", async () => {
    const { a, b } = await creditPair({ options: { credit: { windowBytes: 256 * 1024 } } });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sizes: number[] = [];
    a.onMessage((data) => {
      sizes.push(typeof data === "string" ? data.length : data.byteLength);
      return gate;
    });
    // 1 MiB is the default maxPendingBytes; 4 MiB is far beyond every bound but the message itself.
    for (const size of [1024 * 1024, 4 * 1024 * 1024]) {
      await b.whenDrained();
      b.send(new Uint8Array(size));
      await tick(50);
      expect(a.state).toBe("open");
      if (size === 1024 * 1024) {
        release?.();
        await tick(30);
      }
    }
    expect(a.stats().overloadCloses).toBe(0);
    expect(sizes).toEqual([1024 * 1024, 4 * 1024 * 1024]);
  });

  it("still closes a standard socket whose peer ignores its credit", () => {
    const socket = new FakeSocket();
    const channel = channelFromWebSocket(socket, { maxPendingBytes: 1024, credit: { windowBytes: 1024 } });
    channel.onMessage(() => new Promise<void>(() => {}));
    socket.peerOpen(1024);
    // One huge message is legal whatever its size; the bound applies to what is pending ahead of it.
    socket.receive(new Uint8Array(64 * 1024));
    expect(channel.state).toBe("open");
    socket.receive(new Uint8Array(1));
    expect(socket.closeRequest).toEqual({
      code: CLOSE_CODES.overloaded,
      reason: "Receiver fell 65537 bytes behind, more than 2048",
    });
    expect(channel.stats().overloadCloses).toBe(1);
  });

  it("checks what was pending ahead of each message against the larger of maxPendingBytes and twice the window", () => {
    const socket = new FakeSocket();
    const channel = channelFromWebSocket(socket, { maxPendingBytes: 1024, credit: { windowBytes: 1024 } });
    channel.onMessage(() => new Promise<void>(() => {}));
    socket.peerOpen(1024);
    socket.receive(new Uint8Array(1500)); // 0 ahead
    socket.receive(new Uint8Array(500)); // 1500 ahead
    expect(channel.state).toBe("open");
    socket.receive(new Uint8Array(1)); // 2000 ahead
    expect(channel.state).toBe("open");
    socket.receive(new Uint8Array(1)); // 2001 ahead
    expect(channel.state).toBe("open");
    socket.receive(new Uint8Array(100)); // 2002 ahead
    expect(channel.state).toBe("open");
    socket.receive(new Uint8Array(1)); // 2102 ahead: past 2048
    expect(channel.state).toBe("closed");
  });

  it("is unchanged in plain mode: the message just received counts", () => {
    const socket = new FakeSocket();
    socket.protocol = "";
    const channel = channelFromWebSocket(socket, { maxPendingBytes: 1024 });
    channel.onMessage(() => new Promise<void>(() => {}));
    socket.receive(new Uint8Array(1024));
    expect(socket.closeRequest).toEqual({
      code: CLOSE_CODES.overloaded,
      reason: "Receiver fell 1024 bytes behind, more than 1024",
    });
  });
});

describe("relay into a WebSocket with a smaller credit window", () => {
  it("does not forward a frame to a credit socket that was already past its window when the relay was created", async () => {
    const windowBytes = 16 * 1024;
    const { a, b } = await creditPair({ options: { maxPendingBytes: windowBytes, credit: { windowBytes } } });
    const releases: (() => void)[] = [];
    const received: number[] = [];
    a.onMessage((data) => {
      received.push(typeof data === "string" ? -1 : data.byteLength);
      return new Promise<void>((resolve) => releases.push(resolve));
    });
    // A legal message larger than the window, sent on the socket channel before any relay exists.
    await b.whenDrained();
    b.send(new Uint8Array(2 * windowBytes));
    await tick(30);
    expect(a.state).toBe("open");
    expect(b.bufferedAmount).toBe(2 * windowBytes);

    const { port1, port2 } = new MessageChannel();
    const source = channelFromPort(fromNodePort(port1));
    const near = channelFromPort(fromNodePort(port2));
    cleanups.push(() => {
      source.close();
      near.close();
    });
    await Promise.all([opened(source), opened(near)]);
    const link = relay(near, b);
    await source.whenDrained();
    source.send(new Uint8Array(8 * 1024));
    await tick(30);
    // Before the fix the relay forwarded it at once and the standard socket closed with 4008.
    expect(a.state).toBe("open");
    expect(link.stats().aToB).toMatchObject({ frames: 0, heldBytes: 8 * 1024 });

    for (let turns = 0; turns < 200 && received.length < 2; turns++) {
      for (const release of releases.splice(0)) release();
      await tick(1);
    }
    for (const release of releases.splice(0)) release();
    expect(received).toEqual([2 * windowBytes, 8 * 1024]);
    expect(a.state).toBe("open");
    expect(a.stats().overloadCloses).toBe(0);
    expect(link.stats().aToB).toMatchObject({ frames: 1, heldBytes: 0 });
  });

  it("stops forwarding at the destination's window, holds the source, and delivers everything once it drains", async () => {
    const windowBytes = 16 * 1024;
    const frame = 8 * 1024;
    const frames = 32;
    const { a, b } = await creditPair({ options: { maxPendingBytes: windowBytes, credit: { windowBytes } } });
    // The source is a port channel with the default 1 MiB window, much larger than the destination's.
    const { port1, port2 } = new MessageChannel();
    const source = channelFromPort(fromNodePort(port1));
    const near = channelFromPort(fromNodePort(port2));
    cleanups.push(() => {
      source.close();
      near.close();
    });
    await Promise.all([opened(source), opened(near)]);
    const link = relay(near, b);

    // `a` is a standard socket (cannot pause): before the fix the relay drove it to 4008.
    const releases: (() => void)[] = [];
    const received: number[] = [];
    a.onMessage((data) => {
      received.push(typeof data === "string" ? -1 : data[0]);
      return new Promise<void>((resolve) => releases.push(resolve));
    });
    let sent = 0;
    const producing = (async () => {
      for (let i = 0; i < frames && source.state === "open"; i++) {
        await source.whenDrained();
        source.send(new Uint8Array(frame).fill(i));
        sent++;
      }
    })();

    await tick(100);
    expect(a.state).toBe("open");
    // The relay put at most half the destination's window plus one frame on it, and held the rest.
    expect(link.stats().aToB.bytes).toBeLessThanOrEqual(windowBytes / 2 + frame);
    expect(b.bufferedAmount).toBeLessThanOrEqual(windowBytes / 2 + frame);
    expect(link.stats().aToB.yields).toBe(0);
    // The rest waits in the relay, in order, with the source's acknowledgements held.
    expect(link.stats().aToB.heldBytes).toBe(sent * frame - link.stats().aToB.bytes);
    expect(link.stats().aToB.heldBytes).toBeGreaterThan(0);
    expect(source.bufferedAmount).toBeGreaterThanOrEqual(link.stats().aToB.heldBytes);

    for (let turns = 0; turns < 2000 && received.length < frames; turns++) {
      for (const release of releases.splice(0)) release();
      await tick(1);
    }
    for (const release of releases.splice(0)) release();
    await producing;
    expect(received).toEqual(Array.from({ length: frames }, (_, i) => i));
    expect(a.state).toBe("open");
    expect(a.stats().overloadCloses).toBe(0);
    await tick(30);
    expect(source.bufferedAmount).toBe(0);
  });
});
