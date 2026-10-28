// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { CLOSE_CODES, frameBytes } from "./channel.ts";
import {
  channelFromWebSocket,
  sendableCloseCode,
  type WebSocketChannelOptions,
  type WebSocketLike,
} from "./web-socket.ts";

type Listener = (event: never) => void;

/** A socket the test controls: `bufferedAmount` is set by hand, events are emitted by hand. */
class FakeSocket implements WebSocketLike {
  readyState = 1;
  bufferedAmount = 0;
  binaryType = "blob";
  sent: (string | Uint8Array)[] = [];
  readonly #listeners = new Map<string, Set<Listener>>();

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.emit("close", { code: code ?? 1005, reason: reason ?? "" });
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
}

/** The shape of `ws`: pausable, and `send(data, options, callback)` calling back once per write. */
class FakeWsSocket extends FakeSocket {
  callbacks: ((error?: Error) => void)[] = [];
  pause(): void {}
  resume(): void {}
  override send(data: string | Uint8Array, _options?: object, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    if (callback) this.callbacks.push(callback);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

function settled(promise: Promise<unknown>): () => boolean {
  let done = false;
  void promise.then(() => (done = true));
  return () => done;
}

describe("WebSocket drain: one shared, on-demand check", () => {
  it("runs no timer while nobody waits, one timer for any number of waiters, none after they settle", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const channel = channelFromWebSocket(socket, { lowWaterBytes: 100, drainPollMs: 5 });
    socket.bufferedAmount = 1000;
    expect(vi.getTimerCount()).toBe(0);

    const waits = Array.from({ length: 50 }, () => settled(channel.whenDrained()));
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(waits.some((done) => done())).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    socket.bufferedAmount = 100;
    await vi.advanceTimersByTimeAsync(5);
    expect(waits.every((done) => done())).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves every waiter on close and clears the timer", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const channel = channelFromWebSocket(socket);
    socket.bufferedAmount = 10 * 1024 * 1024;
    const waits = [settled(channel.whenDrained()), settled(channel.whenDrained())];

    socket.emit("close", { code: 1006, reason: "" });
    await vi.advanceTimersByTimeAsync(0);

    expect(waits.every((done) => done())).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await expect(channel.whenDrained()).resolves.toBeUndefined();
  });

  it("uses ws's send callback instead of polling when told to", async () => {
    vi.useFakeTimers();
    const socket = new FakeWsSocket();
    const channel = channelFromWebSocket(socket, { lowWaterBytes: 100, sendWithCallback: true });
    channel.send(new Uint8Array(500));
    channel.send(new Uint8Array(500));
    socket.bufferedAmount = 1000;

    const drained = settled(channel.whenDrained());
    expect(vi.getTimerCount()).toBe(0);

    socket.bufferedAmount = 500;
    socket.callbacks[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(drained()).toBe(false);

    socket.bufferedAmount = 0;
    socket.callbacks[1]();
    await vi.advanceTimersByTimeAsync(0);
    expect(drained()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back to polling when no write is in flight but the buffer is still full", async () => {
    vi.useFakeTimers();
    const socket = new FakeWsSocket();
    const channel = channelFromWebSocket(socket, { lowWaterBytes: 100, drainPollMs: 5, sendWithCallback: true });
    channel.send("x");
    socket.bufferedAmount = 1000; // e.g. frames written to the socket outside the channel
    const drained = settled(channel.whenDrained());
    socket.callbacks[0]();
    expect(vi.getTimerCount()).toBe(1);

    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(5);
    expect(drained()).toBe(true);
  });

  it.each<[string, WebSocketChannelOptions, boolean]>([
    ["sendWithCallback: false on a ws-shaped socket", { sendWithCallback: false }, false],
    ["the default on a ws-shaped socket", {}, false],
    ["sendWithCallback: true on a ws-shaped socket", { sendWithCallback: true }, true],
  ])("honours %s", (_name, options, expectCallback) => {
    const socket = new FakeWsSocket();
    const channel = channelFromWebSocket(socket, options);
    channel.send("x");
    expect(socket.callbacks.length > 0).toBe(expectCallback);
  });

  it("uses the callback form when told to, even on a socket that does not look like ws", () => {
    const socket = new FakeSocket();
    const calls: unknown[][] = [];
    socket.send = (...args: unknown[]) => void calls.push(args);
    const channel = channelFromWebSocket(socket, { sendWithCallback: true });
    channel.send("x");
    expect(calls[0]).toHaveLength(3);
    expect(typeof calls[0][2]).toBe("function");
  });

  it("polls by default for a ws-shaped socket whose three-argument send never calls back", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    // Pausable, with a three-parameter `send` that is not `ws`'s: the third argument is no callback.
    Object.assign(socket, { pause() {}, resume() {} });
    // oxlint-disable-next-line no-unused-vars -- the declared arity is the point
    socket.send = (data: string | Uint8Array, _isBinary?: boolean, _compress?: boolean) => {
      socket.bufferedAmount += frameBytes(data);
      setTimeout(() => (socket.bufferedAmount = 0), 10);
    };
    expect(socket.send.length).toBe(3);
    const channel = channelFromWebSocket(socket, { lowWaterBytes: 0, drainPollMs: 5 });
    channel.send(new Uint8Array(100));
    const drained = settled(channel.whenDrained());

    await vi.advanceTimersByTimeAsync(40);
    expect(socket.bufferedAmount).toBe(0);
    expect(drained()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not use the callback form on a standard-shaped socket by default", () => {
    const socket = new FakeSocket();
    const calls: unknown[][] = [];
    socket.send = (...args: unknown[]) => void calls.push(args);
    channelFromWebSocket(socket).send("x");
    expect(calls[0]).toEqual(["x"]);
  });
});

describe("WebSocket channel options", () => {
  it.each<[string, WebSocketChannelOptions]>([
    ["a zero poll interval", { drainPollMs: 0 }],
    ["a NaN poll interval", { drainPollMs: Number.NaN }],
    ["a negative low-water mark", { lowWaterBytes: -1 }],
    ["a fractional low-water mark", { lowWaterBytes: 0.5 }],
    ["a zero maxPendingBytes", { maxPendingBytes: 0 }],
    ["an infinite maxPendingBytes", { maxPendingBytes: Number.POSITIVE_INFINITY }],
    ["a zero maxPendingFrames", { maxPendingFrames: 0 }],
    ["a fractional maxPendingFrames", { maxPendingFrames: 1.5 }],
    ["a NaN maxPendingFrames", { maxPendingFrames: Number.NaN }],
    ["a negative maxMessageBytes", { maxMessageBytes: -1 }],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately the wrong type
    ["a non-boolean sendWithCallback", { sendWithCallback: "yes" as unknown as boolean }],
  ])("throws synchronously on %s, before touching the socket", (_name, options) => {
    const socket = new FakeSocket();
    expect(() => channelFromWebSocket(socket, options)).toThrow(/must/);
    expect(socket.binaryType).toBe("blob");
  });
});

describe("WebSocket channel stats", () => {
  it("counts frames, bytes, held bytes and drain time", async () => {
    const socket = new FakeSocket();
    const channel = channelFromWebSocket(socket, { lowWaterBytes: 0, drainPollMs: 5 });
    let release: (() => void) | undefined;
    channel.onMessage(() => new Promise<void>((resolve) => (release = resolve)));

    channel.send("héllo");
    channel.send(new Uint8Array(4));
    socket.emit("message", { data: new Uint8Array(7).buffer });
    expect(channel.stats()).toMatchObject({
      framesSent: 2,
      bytesSent: 10,
      framesReceived: 1,
      bytesReceived: 7,
      heldBytes: 7,
      heldFrames: 1,
    });

    release?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(channel.stats()).toMatchObject({ heldBytes: 0, heldFrames: 0 });

    socket.bufferedAmount = 1;
    const drained = channel.whenDrained();
    await new Promise((resolve) => setTimeout(resolve, 30));
    socket.bufferedAmount = 0;
    await drained;
    expect(channel.stats().drainWaitMs).toBeGreaterThanOrEqual(25);
  });

  it("counts an overload close once", () => {
    const socket = new FakeSocket();
    socket.close = (code?: number, reason?: string) => {
      socket.readyState = 2; // closing: the close event comes later
      void code;
      void reason;
    };
    const channel = channelFromWebSocket(socket, { maxPendingBytes: 8 });
    channel.onMessage(() => new Promise<void>(() => {}));
    for (let i = 0; i < 4; i++) socket.emit("message", { data: new Uint8Array(8).buffer });
    expect(channel.stats().overloadCloses).toBe(1);
  });
});

describe("sendableCloseCode", () => {
  it("maps the protocol error code to 4002", () => {
    expect(sendableCloseCode(CLOSE_CODES.protocolError)).toBe(4002);
  });
});
