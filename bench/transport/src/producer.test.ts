import { describe, expect, it } from "vitest";

import type { RunConfig } from "./config.ts";
import type { CloseInfo, Endpoint } from "./endpoint.ts";
import { runPeer } from "./peer.ts";
import { runProducer } from "./producer.ts";
import { DEFAULT_SEND_BUDGET } from "./scheduler.ts";

/** Two endpoints joined in memory, every message delivered `delayMs` later, in order. */
function delayedPair(delayMs: number): [Endpoint, Endpoint] {
  type Handler = (data: string | Uint8Array) => unknown;
  const handlers: [Handler | undefined, Handler | undefined] = [undefined, undefined];
  const make = (self: 0 | 1): Endpoint => ({
    send: (data) => {
      setTimeout(() => void handlers[self === 0 ? 1 : 0]?.(data), delayMs);
    },
    onMessage: (handler) => {
      handlers[self] = handler;
      return () => {};
    },
    onClose: () => () => {},
    close: () => {},
    ready: () => Promise.resolve(),
  });
  return [make(0), make(1)];
}

describe("runProducer goodput", () => {
  it("counts only what the peer consumed in its window; the drain is reported apart", async () => {
    const config: RunConfig = {
      link: "same-thread",
      variant: "raw",
      suite: "smoke",
      seed: 1,
      windowBytes: 1 << 20,
      sendBudget: DEFAULT_SEND_BUDGET,
      warmupMs: 0,
      measureMs: 100,
      options: {},
      caseSpec: {
        name: "test",
        description: "test",
        stream: { frameBytes: 64, ratePerSec: 200, totalBytes: 0, kind: "random" },
      },
    };
    const [sender, receiver] = delayedPair(30);
    const peer = runPeer(receiver, config);
    const result = await runProducer(sender, config);
    peer.stop();

    const { goodput, drain } = result;
    if (!drain) throw new Error("no drain");
    // The window is the configured length on the peer's clock, and its rate uses that length.
    expect(goodput.measureMs).toBeGreaterThanOrEqual(99);
    expect(goodput.measureMs).toBeLessThan(150);
    expect(goodput.bytesPerSec).toBe(Math.round((goodput.bytes / goodput.measureMs) * 1000));
    // A 30 ms one-way delay leaves frames in flight when the window closes; they are drained, not counted.
    expect(drain.inFlightAtEnd.messages).toBeGreaterThan(0);
    expect(goodput.messages + drain.inFlightAtEnd.messages).toBe(drain.messages);
    expect(drain.messages).toBe(result.stream?.sent);
    expect(drain.drainMs).toBeGreaterThanOrEqual(25);
    expect(drain.bytesPerSec).toBe(Math.round((drain.bytes / (drain.submissionMs + drain.drainMs)) * 1000));
    expect(result.peer.metrics?.wallMs).toBeGreaterThanOrEqual(99);
  });
});

describe("runProducer latency", () => {
  it("counts sampled acknowledgements that arrive during the drain", async () => {
    const config: RunConfig = {
      link: "same-thread",
      variant: "raw",
      suite: "smoke",
      seed: 1,
      windowBytes: 1 << 20,
      sendBudget: DEFAULT_SEND_BUDGET,
      warmupMs: 0,
      measureMs: 100,
      options: {},
      caseSpec: {
        name: "test",
        description: "test",
        stream: { frameBytes: 64, ratePerSec: 200, totalBytes: 0, kind: "random" },
      },
    };
    // 30 ms one way: the acknowledgement of frame 16 (sent near the window end) comes back in the drain.
    const [sender, receiver] = delayedPair(30);
    const peer = runPeer(receiver, config);
    const result = await runProducer(sender, config);
    peer.stop();
    const stream = result.stream;
    if (!stream || !result.drain) throw new Error("no stream stats or drain");
    expect(result.drain.messages).toBe(stream.sent);
    // Sampled frames are seq 0 and 16; both were consumed in the drain at the latest, so both count.
    expect(stream.sent).toBeGreaterThan(16);
    expect(stream.completed).toBe(2);
    expect(stream.fromIntended.samples).toBe(2);
    expect(stream.censored).toBe(0);
  });
});

describe("runProducer remote close", () => {
  it("ends the run with `closed` instead of waiting on the closed connection", async () => {
    const config: RunConfig = {
      link: "same-thread",
      variant: "raw",
      suite: "smoke",
      seed: 1,
      windowBytes: 1024,
      sendBudget: DEFAULT_SEND_BUDGET,
      warmupMs: 200,
      measureMs: 200,
      options: {},
      caseSpec: {
        name: "test",
        description: "test",
        stream: { frameBytes: 64, ratePerSec: 1000, totalBytes: 0, kind: "random" },
        consumer: { bytesPerSec: 640 },
      },
    };
    // The peer never answers; the connection closes with 4008 50 ms into the warmup.
    let onClose: ((info: CloseInfo) => void) | undefined;
    const sender: Endpoint = {
      send: () => {},
      onMessage: () => () => {},
      onClose: (handler) => {
        onClose = handler;
        return () => {};
      },
      close: () => {},
      ready: () => Promise.resolve(),
    };
    setTimeout(() => onClose?.({ code: 4008, reason: "overloaded" }), 50);
    const start = performance.now();
    const result = await runProducer(sender, config);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(result.closed).toMatchObject({ code: 4008, reason: "overloaded", phase: "warmup" });
    expect(result.goodput.messages).toBe(0);
  });
});
