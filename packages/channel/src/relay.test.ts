// @vitest-environment node
import { MessageChannel } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import { type Channel, type ChannelCloseInfo, CLOSE_CODES, DRAINED, frameBytes, opened } from "./channel.ts";
import { channelFromPort, fromNodePort, type PortChannelOptions } from "./message-port.ts";
import { Forwarder, relay, type RelayOptions } from "./relay.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function portPair(options: PortChannelOptions = {}) {
  const { port1, port2 } = new MessageChannel();
  const a = channelFromPort(fromNodePort(port1), options);
  const b = channelFromPort(fromNodePort(port2), options);
  cleanups.push(() => {
    a.close();
    b.close();
  });
  await Promise.all([opened(a), opened(b)]);
  return { a, b };
}

function closeInfo(channel: Channel): Promise<ChannelCloseInfo> {
  return new Promise((resolve) => channel.onClose(resolve));
}

describe("relay scheduling", () => {
  it("lets a close from the other side through a long burst within a few quanta", async () => {
    const windowBytes = 64 * 1024 * 1024;
    const left = await portPair({ windowBytes });
    const right = await portPair({ windowBytes });
    const quantumBytes = 64 * 1024;
    const link = relay(left.b, right.a, { quantumBytes, quantumMs: 1000 });
    const frame = new Uint8Array(16 * 1024);
    const frames = 1000; // 16 MiB in one burst
    // The far consumer closes as soon as the burst starts arriving.
    right.b.onMessage(() => right.b.close(4001, "enough"));
    // Registered after the relay's own close handler: sees what the relay forwarded by then.
    let forwardedAtClose = -1;
    right.a.onClose(() => (forwardedAtClose = link.stats().aToB.bytes));
    const closedLeft = closeInfo(left.a);

    for (let i = 0; i < frames; i++) left.a.send(frame);

    expect(await closedLeft).toMatchObject({ code: 4001, reason: "enough" });
    await link.done;
    expect(forwardedAtClose).toBeGreaterThan(0);
    // Without scheduling every frame of the burst is forwarded before the close is even read.
    expect(forwardedAtClose).toBeLessThanOrEqual(8 * quantumBytes);
    // Stops between quanta, not one per frame.
    expect(link.stats().aToB.yields).toBeGreaterThan(0);
    expect(link.stats().aToB.yields).toBeLessThanOrEqual(8);
  });

  it("keeps FIFO order per direction across yields, both directions at once", async () => {
    const left = await portPair();
    const right = await portPair();
    const link = relay(left.b, right.a, { quantumBytes: 1, quantumMs: 0 });
    const toRight: string[] = [];
    const toLeft: string[] = [];
    right.b.onMessage((data) => void toRight.push(String(data)));
    left.a.onMessage((data) => void toLeft.push(String(data)));

    const expected = Array.from({ length: 200 }, (_, i) => `m${i}`);
    for (const message of expected) {
      left.a.send(message);
      right.b.send(message);
    }
    await tick(200);

    expect(toRight).toEqual(expected);
    expect(toLeft).toEqual(expected);
    expect(link.stats().aToB.yields).toBeGreaterThan(0);
    expect(link.stats().bToA.yields).toBeGreaterThan(0);
    expect(left.a.bufferedAmount).toBe(0);
    expect(right.b.bufferedAmount).toBe(0);
  });

  it("keeps backpressure: the source's ack waits for the destination to drain", async () => {
    const windowBytes = 4096;
    const left = await portPair({ windowBytes });
    const right = await portPair({ windowBytes });
    relay(left.b, right.a, { quantumBytes: 2048 });
    let consumed = 0;
    let maxOutstanding = 0;
    right.b.onMessage(async (data) => {
      await tick(2);
      consumed += frameBytes(data);
    });

    for (let i = 0; i < 40; i++) {
      if (left.a.bufferedAmount >= windowBytes) await left.a.whenDrained();
      left.a.send(new Uint8Array(1024));
      maxOutstanding = Math.max(maxOutstanding, left.a.bufferedAmount, right.a.bufferedAmount);
    }
    await left.a.whenDrained();
    await tick(200);

    expect(consumed).toBe(40 * 1024);
    expect(maxOutstanding).toBeLessThanOrEqual(windowBytes + 1024);
  });
});

/**
 * A source with a 64 MiB window relayed into a destination with a 4 KiB one, whose consumer holds
 * every frame until released: the destination's window, not the source's, must bound forwarding.
 */
async function intoSmallWindow(options: RelayOptions = {}, wrap: (channel: Channel) => Channel = (c) => c) {
  const left = await portPair({ windowBytes: 64 * 1024 * 1024 });
  const right = await portPair({ windowBytes: 4096 });
  const link = relay(left.b, wrap(right.a), options);
  const releases: (() => void)[] = [];
  const received: number[] = [];
  right.b.onMessage((data) => {
    received.push(typeof data === "string" ? -1 : data[0]);
    return new Promise<void>((resolve) => releases.push(resolve));
  });
  const frames = 64;
  for (let i = 0; i < frames; i++) left.a.send(new Uint8Array(1024).fill(i));
  await tick(50);
  const releaseAll = async () => {
    for (let turns = 0; turns < 1000 && received.length < frames; turns++) {
      for (const release of releases.splice(0)) release();
      await tick(1);
    }
    for (const release of releases.splice(0)) release();
  };
  return { left, right, link, received, releases, frames, releaseAll };
}

/** A channel that forwards to `channel` but cannot say synchronously whether it drained. */
function opaque(channel: Channel): Channel {
  return {
    get state() {
      return channel.state;
    },
    get everOpened() {
      return channel.everOpened;
    },
    get bufferedAmount() {
      return channel.bufferedAmount;
    },
    send: (data) => channel.send(data),
    whenDrained: () => channel.whenDrained(),
    onOpen: (handler) => channel.onOpen(handler),
    onMessage: (handler) => channel.onMessage(handler),
    onClose: (handler) => channel.onClose(handler),
    close: (code, reason) => channel.close(code, reason),
    stats: () => channel.stats(),
  };
}

describe("relay backpressure from the destination", () => {
  it.each([
    ["a package channel", (c: Channel) => c],
    ["a channel without the synchronous drain check", opaque],
  ])("stops forwarding while %s is not drained and resumes in order", async (_name, wrap) => {
    const { left, right, link, received, frames, releaseAll } = await intoSmallWindow({}, wrap);
    // Low water is half the 4 KiB window: forwarding stops once a frame crosses it.
    expect(right.a.bufferedAmount).toBeLessThanOrEqual(2048 + 1024);
    expect(link.stats().aToB.frames).toBeLessThanOrEqual(3);
    expect(link.stats().aToB.heldBytes).toBe(frames * 1024 - link.stats().aToB.bytes);
    // Not a quantum yield: the relay waits for the destination.
    expect(link.stats().aToB.yields).toBe(0);
    // Everything not forwarded keeps its acknowledgement at the source.
    expect(left.a.bufferedAmount).toBeGreaterThanOrEqual(link.stats().aToB.heldBytes);

    await releaseAll();
    expect(received).toEqual(Array.from({ length: frames }, (_, i) => i));
    await tick(20);
    expect(left.a.bufferedAmount).toBe(0);
    expect(link.stats().aToB).toMatchObject({ frames, heldBytes: 0 });
  });

  it("follows the queued frames with a normal close from the source once the destination drains", async () => {
    const { left, right, received, frames, releaseAll } = await intoSmallWindow();
    let closedWith: ChannelCloseInfo | undefined;
    right.b.onClose((info) => (closedWith = info));
    left.a.close(1000, "done");
    await tick(30);
    expect(closedWith).toBeUndefined();
    await releaseAll();
    await tick(20);
    expect(received).toHaveLength(frames);
    expect(closedWith).toMatchObject({ code: 1000, reason: "done" });
  });

  it("is interrupted by a close with an abort code from the source", async () => {
    const { left, right, link, received } = await intoSmallWindow({ abortCodes: [4001] });
    const closed = closeInfo(right.b);
    left.a.close(4001, "cancel");
    expect(await closed).toMatchObject({ code: 4001, reason: "cancel" });
    await link.done;
    expect(received.length).toBeLessThanOrEqual(3);
    expect(link.stats().aToB.heldBytes).toBe(0);
  });

  it("is interrupted by a close from the destination's side", async () => {
    const { left, right, link } = await intoSmallWindow();
    const closed = closeInfo(left.a);
    right.b.close(4002, "consumer gone");
    expect(await closed).toMatchObject({ code: 4002, reason: "consumer gone" });
    await link.done;
    expect(link.stats().aToB.heldBytes).toBe(0);
  });

  it("is interrupted by link.close(), which drops the queue and releases the source", async () => {
    const { left, link } = await intoSmallWindow();
    const closed = closeInfo(left.a);
    link.close(4003, "shutdown");
    expect(link.stats().aToB.heldBytes).toBe(0);
    expect(await closed).toMatchObject({ code: 4003, reason: "shutdown" });
    await link.done;
  });
});

describe("relay admission", () => {
  it.each([
    ["a package channel", (c: Channel) => c],
    ["a channel without the synchronous drain check", opaque],
  ])(
    "does not forward to %s that was already above its low-water mark when the relay was created",
    async (_name, wrap) => {
      const left = await portPair();
      const right = await portPair({ windowBytes: 4096 });
      const releases: (() => void)[] = [];
      const received: number[] = [];
      right.b.onMessage((data) => {
        received.push(typeof data === "string" ? -1 : data.byteLength);
        return new Promise<void>((resolve) => releases.push(resolve));
      });
      // Filled before the relay existed: 3000 bytes outstanding, above the 2048-byte low-water mark.
      right.a.send(new Uint8Array(3000));
      await tick();
      expect(right.a.bufferedAmount).toBe(3000);

      const link = relay(left.b, wrap(right.a));
      left.a.send(new Uint8Array(1024));
      await tick();
      expect(link.stats().aToB).toMatchObject({ frames: 0, heldBytes: 1024 });
      expect(right.a.bufferedAmount).toBe(3000);
      expect(left.a.bufferedAmount).toBe(1024);

      for (const release of releases.splice(0)) release();
      await tick();
      for (const release of releases.splice(0)) release();
      await tick();
      expect(received).toEqual([3000, 1024]);
      expect(link.stats().aToB).toMatchObject({ frames: 1, heldBytes: 0 });
      expect(left.a.bufferedAmount).toBe(0);
    },
  );
});

describe("relay admission after an idle period", () => {
  it("asks a channel without the synchronous drain check again once another writer filled it", async () => {
    const left = await portPair();
    const right = await portPair({ windowBytes: 4096 });
    const releases: (() => void)[] = [];
    const received: number[] = [];
    right.b.onMessage((data) => {
      received.push(typeof data === "string" ? -1 : data.byteLength);
      return new Promise<void>((resolve) => releases.push(resolve));
    });
    const link = relay(left.b, opaque(right.a));
    // One frame through and fully drained, then idle.
    left.a.send(new Uint8Array(512));
    await tick();
    for (const release of releases.splice(0)) release();
    await tick();
    expect(right.a.bufferedAmount).toBe(0);
    expect(link.stats().aToB).toMatchObject({ frames: 1, heldBytes: 0 });

    // Another writer fills the destination past its low-water mark; its consumer holds it.
    right.a.send(new Uint8Array(3000));
    await tick();
    expect(right.a.bufferedAmount).toBe(3000);
    left.a.send(new Uint8Array(1024));
    await tick();
    expect(link.stats().aToB).toMatchObject({ frames: 1, heldBytes: 1024 });
    expect(right.a.bufferedAmount).toBe(3000);

    for (const release of releases.splice(0)) release();
    await tick();
    for (const release of releases.splice(0)) release();
    await tick();
    expect(received).toEqual([512, 3000, 1024]);
    expect(link.stats().aToB).toMatchObject({ frames: 2, heldBytes: 0 });
  });
});

/** A destination the test drives: every send leaves it above its low-water mark until `drain()`. */
class FillingDestination implements Channel {
  state = "open" as const;
  everOpened = true;
  bufferedAmount = 0;
  sent: (string | Uint8Array)[] = [];
  #drained = true;
  #waiters: (() => void)[] = [];

  get [DRAINED](): boolean {
    return this.#drained;
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
    this.#drained = false;
  }

  drain(): void {
    this.#drained = true;
    for (const wake of this.#waiters.splice(0)) wake();
  }

  whenDrained(): Promise<void> {
    return this.#drained ? Promise.resolve() : new Promise((resolve) => this.#waiters.push(resolve));
  }

  onOpen = () => () => {};
  onMessage = () => () => {};
  onClose = () => () => {};
  close(): void {}
  stats = () => {
    throw new Error("not used");
  };
}

describe("relay queue storage", () => {
  it("stays proportional to what is queued while the queue never empties", async () => {
    const to = new FillingDestination();
    const forwarder = new Forwarder(to, {
      maxPendingBytes: 1024,
      maxQueuedFrames: 1024,
      quantumBytes: Number.MAX_SAFE_INTEGER,
      quantumMs: 60_000,
      tooMuchHeld: () => expect.fail("not connecting"),
      tooManyQueued: () => expect.fail("never more than 10 queued"),
    });
    let next = 0;
    const push = () => void forwarder.push(String(next++));
    // One frame forwarded (the destination fills), nine queued behind it.
    for (let i = 0; i < 10; i++) push();
    expect(forwarder.queueStorage).toEqual({ queued: 9, slots: 9 });

    let maxSlots = 0;
    for (let i = 0; i < 5000; i++) {
      // The destination drains, takes exactly one frame and fills again; one more frame arrives.
      to.drain();
      await Promise.resolve();
      push();
      expect(forwarder.queueStorage.queued).toBe(9);
      maxSlots = Math.max(maxSlots, forwarder.queueStorage.slots);
    }
    expect(to.sent).toHaveLength(5001);
    expect(to.sent).toEqual(Array.from({ length: 5001 }, (_, i) => String(i)));
    // Without compaction the array would hold every forwarded slot (5009 here).
    expect(maxSlots).toBeLessThanOrEqual(2 * 1024 + 9);
    expect(forwarder.queueStorage.slots).toBeLessThan(1024 + 10);
    forwarder.stop();
  });
});

describe("relay frame cap", () => {
  it("closes both sides as overloaded when empty frames pile up behind a stuck destination", async () => {
    const left = await portPair();
    const right = await portPair({ windowBytes: 2, lowWaterBytes: 0 });
    right.b.onMessage(() => new Promise<void>(() => {}));
    const link = relay(left.b, right.a, { maxQueuedFrames: 100 });
    const leftClosed = closeInfo(left.a);
    const rightClosed = closeInfo(right.b);
    // Fills the destination; everything after it is queued in the relay.
    left.a.send(new Uint8Array(2));
    // Empty frames count 0 bytes: the source's window never stops a producer that awaits drain.
    for (let i = 0; i < 200 && left.a.state === "open"; i++) {
      await left.a.whenDrained();
      if (left.a.state !== "open") break;
      left.a.send(i % 2 === 0 ? "" : new Uint8Array(0));
      if (i % 20 === 0) await tick(1);
    }
    const reason = "Queued 101 frames in the relay, more than 100";
    expect(await leftClosed).toMatchObject({ code: CLOSE_CODES.overloaded, reason });
    expect(await rightClosed).toMatchObject({ code: CLOSE_CODES.overloaded, reason });
    await link.done;
    expect(link.stats()).toMatchObject({ overloadCloses: 1, aToB: { frames: 1, heldBytes: 0 } });
  });

  it("counts frames queued at once, not frames forwarded", async () => {
    const left = await portPair();
    const right = await portPair();
    let received = 0;
    right.b.onMessage(() => void received++);
    const link = relay(left.b, right.a, { maxQueuedFrames: 1 });
    // One frame per turn: each is forwarded as it arrives, so nothing ever queues.
    for (let i = 0; i < 1000; i++) {
      await left.a.whenDrained();
      left.a.send("");
      await new Promise((resolve) => setImmediate(resolve));
    }
    await tick(50);
    expect(received).toBe(1000);
    expect(link.stats().overloadCloses).toBe(0);
  });
});

async function consumerClosesWithBacklog(options: RelayOptions) {
  const left = await portPair();
  const right = await portPair();
  const link = relay(left.b, right.a, options);
  // left.a is the far side, right.b the consumer; both send 32 x 16 KiB without being read fast.
  const farEvents: unknown[] = [];
  left.a.onMessage((data) => void farEvents.push(typeof data === "string" ? data : data[0]));
  const farClosed = new Promise<number>((resolve) =>
    left.a.onClose((info) => {
      farEvents.push({ code: info.code, reason: info.reason });
      resolve(performance.now());
    }),
  );
  right.b.onMessage(async () => {
    await tick(1);
  });
  for (let i = 0; i < 32; i++) {
    await right.b.whenDrained();
    right.b.send(new Uint8Array(16 * 1024).fill(i + 1));
    await left.a.whenDrained();
    left.a.send(new Uint8Array(16 * 1024).fill(i + 1));
  }
  const start = performance.now();
  right.b.close(4001, "consumer cancelled");
  const closedAt = await farClosed;
  await link.done;
  const frames = farEvents.filter((event) => typeof event === "number");
  return { farEvents, frames, elapsed: closedAt - start, link };
}

describe("relay close ordering", () => {
  it.each<[string, RelayOptions, "aToB" | "bToA", number]>([
    ["the default quantum, a to b", {}, "aToB", 1000],
    ["the default quantum, b to a", {}, "bToA", 1000],
    ["a one-byte quantum, a to b", { quantumBytes: 1, quantumMs: 0 }, "aToB", 1000],
    ["a one-byte quantum, b to a", { quantumBytes: 1, quantumMs: 0 }, "bToA", 1000],
    ["an application code, a to b", {}, "aToB", 4000],
    ["an application code and a one-byte quantum, b to a", { quantumBytes: 1, quantumMs: 0 }, "bToA", 4000],
  ])("delivers every frame before the source's close with %s", async (_name, options, direction, code) => {
    const left = await portPair();
    const right = await portPair();
    const link = relay(left.b, right.a, options);
    const [source, sink] = direction === "aToB" ? [left.a, right.b] : [right.b, left.a];
    // 8 × 16 KiB with distinct contents (twice the default quantum), strings in between.
    const sent: (string | Uint8Array)[] = [];
    for (let i = 0; i < 8; i++) sent.push(new Uint8Array(16 * 1024).fill(i + 1), `m${i}`);
    const events: unknown[] = [];
    sink.onMessage((data) => void events.push(typeof data === "string" ? data : Array.from(new Set(data))));
    const closed = new Promise<void>((resolve) =>
      sink.onClose((info) => {
        events.push({ code: info.code, reason: info.reason });
        resolve();
      }),
    );

    for (const data of sent) {
      await source.whenDrained();
      source.send(data);
    }
    source.close(code, "all sent");
    await closed;
    await link.done;

    expect(events).toEqual([
      ...sent.map((data) => (typeof data === "string" ? data : [data[0]])),
      { code, reason: "all sent" },
    ]);
    expect(link.stats()[direction]).toMatchObject({ frames: sent.length, heldBytes: 0 });
  });

  it("forwards frames held for an unopened destination before a normal close", async () => {
    const left = await portPair();
    const { port1, port2 } = new MessageChannel();
    const unopened = channelFromPort(fromNodePort(port1));
    cleanups.push(() => {
      port1.close();
      port2.close();
    });
    const link = relay(left.b, unopened);
    left.a.send("first");
    left.a.send("second");
    left.a.close(1000, "done");
    await tick();

    const peer = channelFromPort(fromNodePort(port2));
    cleanups.push(() => peer.close());
    const events: unknown[] = [];
    peer.onMessage((data) => void events.push(data));
    peer.onClose((info) => void events.push({ code: info.code, reason: info.reason }));
    await link.done;
    await tick();
    expect(events).toEqual(["first", "second", { code: 1000, reason: "done" }]);
  });

  describe("a consumer closing with backlog in both directions", () => {
    it("delivers the consumer's queued frames before its close by default", async () => {
      const { farEvents, frames } = await consumerClosesWithBacklog({});
      expect(farEvents.at(-1)).toEqual({ code: 4001, reason: "consumer cancelled" });
      expect(frames).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
    });

    it("propagates a code in abortCodes before the remaining backlog", async () => {
      const { farEvents, frames, elapsed } = await consumerClosesWithBacklog({ abortCodes: [4001] });
      expect(farEvents.at(-1)).toEqual({ code: 4001, reason: "consumer cancelled" });
      expect(frames.length).toBeLessThan(32);
      expect(elapsed).toBeLessThan(1000);
    });
  });

  it("rejects an invalid close code without changing state, so a valid close still works", async () => {
    const left = await portPair();
    const right = await portPair();
    const link = relay(left.b, right.a);
    const closedRight = closeInfo(right.b);

    expect(() => link.close(999)).toThrow(RangeError);
    expect(() => link.close(1000.5)).toThrow(RangeError);
    expect([left.b.state, right.a.state]).toEqual(["open", "open"]);

    link.close(1000, "recover");
    await link.done;
    expect(await closedRight).toMatchObject({ code: 1000, reason: "recover" });
  });
});

describe("relay stats", () => {
  it("counts frames and bytes per direction and bytes held for an unopened destination", async () => {
    const left = await portPair();
    const { port1, port2 } = new MessageChannel();
    const unopened = channelFromPort(fromNodePort(port1));
    cleanups.push(() => {
      port1.close();
      port2.close();
    });
    const link = relay(left.b, unopened);

    left.a.send("abc");
    left.a.send(new Uint8Array(5));
    await tick();
    expect(link.stats().aToB).toMatchObject({ frames: 0, heldBytes: 8 });

    const peer = channelFromPort(fromNodePort(port2));
    cleanups.push(() => peer.close());
    peer.onMessage(() => {});
    await opened(peer);
    await tick();
    expect(link.stats()).toMatchObject({
      aToB: { frames: 2, bytes: 8, heldBytes: 0 },
      bToA: { frames: 0, bytes: 0 },
      overloadCloses: 0,
    });
  });

  it("counts a setup failure for too many held bytes", async () => {
    const left = await portPair();
    const { port1, port2 } = new MessageChannel();
    cleanups.push(() => {
      port1.close();
      port2.close();
    });
    const link = relay(left.b, channelFromPort(fromNodePort(port1)), { maxPendingBytes: 10 });
    left.a.send(new Uint8Array(6));
    left.a.send(new Uint8Array(6));
    await link.done;
    expect(link.stats().overloadCloses).toBe(1);
  });
});

describe("relay options", () => {
  it.each<[string, RelayOptions]>([
    ["a zero quantum", { quantumBytes: 0 }],
    ["a negative quantum time", { quantumMs: -1 }],
    ["a NaN open timeout", { openTimeoutMs: Number.NaN }],
    ["a zero open timeout", { openTimeoutMs: 0 }],
    ["a negative maxPendingBytes", { maxPendingBytes: -1 }],
    ["a zero maxQueuedFrames", { maxQueuedFrames: 0 }],
    ["a fractional maxQueuedFrames", { maxQueuedFrames: 1.5 }],
    ["an abort code below 1000", { abortCodes: [999] }],
    ["an abort code above 4999", { abortCodes: [4001, 5000] }],
    ["a fractional abort code", { abortCodes: [4001.5] }],
    ["a NaN abort code", { abortCodes: [Number.NaN] }],
  ])("throws synchronously on %s, before touching the channels", (_name, options) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validation must throw before the channels are used
    const untouched = {} as Channel;
    expect(() => relay(untouched, untouched, options)).toThrow(RangeError);
  });
});
