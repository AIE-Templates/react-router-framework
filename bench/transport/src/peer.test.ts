import { describe, expect, it } from "vitest";

import type { PeerCloseReport } from "./backlog.ts";
import type { RunConfig } from "./config.ts";
import type { CloseInfo, Endpoint } from "./endpoint.ts";
import { expect as expectShape, isPeerCloseReport, isPeerStats } from "./guards.ts";
import { runPeer } from "./peer.ts";
import { encodeFrame, FLAG_SAMPLE } from "./protocol.ts";
import { DEFAULT_SEND_BUDGET } from "./scheduler.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeEndpoint() {
  const sent: { t: string; [key: string]: unknown }[] = [];
  let handler: ((data: string | Uint8Array) => void | Promise<void>) | undefined;
  let closeHandler: ((info: CloseInfo) => void) | undefined;
  const endpoint: Endpoint = {
    send: (data) => {
      if (typeof data === "string") sent.push(JSON.parse(data));
    },
    onMessage: (h) => {
      handler = h;
      return () => {};
    },
    onClose: (h) => {
      closeHandler = h;
      return () => {};
    },
    close: () => {},
    ready: () => Promise.resolve(),
  };
  const remoteClose = (info: CloseInfo) => closeHandler?.(info);
  const deliver = (data: string | Uint8Array) => {
    if (!handler) throw new Error("no handler");
    return handler(data);
  };
  return { endpoint, sent, deliver, remoteClose };
}

function config(
  variant: "raw" | "package",
  slowConsumer?: { everyMs: number; pauseMs: number },
  consumer?: { bytesPerSec: number; recoverAtFraction?: number },
): RunConfig {
  return {
    link: "same-thread",
    variant,
    suite: "smoke",
    seed: 1,
    windowBytes: 128,
    sendBudget: DEFAULT_SEND_BUDGET,
    warmupMs: 0,
    measureMs: 10_000,
    options: {},
    caseSpec: {
      name: "test",
      description: "test",
      stream: { frameBytes: 64, ratePerSec: 100, totalBytes: 0, kind: "random" },
      slowConsumer,
      consumer,
      rpc: { ratePerSec: 1, requestBytes: 64, responseBytes: 64 },
    },
  };
}

describe("runPeer slow consumer", () => {
  for (const variant of ["raw", "package"] as const) {
    it(`${variant}: holds consumption, acks, credit and later barriers until the pause ends`, async () => {
      const { endpoint, sent, deliver } = fakeEndpoint();
      const peer = runPeer(endpoint, config(variant, { everyMs: 10, pauseMs: 40 }));
      await sleep(15);
      void deliver(JSON.stringify({ t: "measure" }));
      const pauseStart = performance.now();
      const held = [0, 1, 2, 3].map((seq) => deliver(encodeFrame(seq, FLAG_SAMPLE, new Uint8Array(64))));
      void deliver(JSON.stringify({ t: "barrier", id: 1 }));

      // Paused: nothing consumed, acknowledged, credited or answered yet; every handler is held.
      expect(sent).toEqual([]);
      for (const promise of held) expect(promise).toBeInstanceOf(Promise);

      await Promise.all(held.map((promise) => Promise.resolve(promise)));
      expect(performance.now() - pauseStart).toBeGreaterThanOrEqual(35);
      expect(sent.filter((m) => m.t === "ack").map((m) => m.seq)).toEqual([0, 1, 2, 3]);
      const credit = sent.filter((m) => m.t === "credit").reduce((n, m) => n + Number(m.bytes), 0);
      expect(credit).toBe(variant === "raw" ? 4 * 72 : 0);
      // The barrier is answered after the frames that arrived before it, with them counted.
      expect(sent.at(-1)).toMatchObject({ t: "barrierr", id: 1, bytes: 256, messages: 4, lastSeq: 3 });

      void deliver(JSON.stringify({ t: "stats" }));
      const stats = sent.at(-1);
      expect(stats?.t).toBe("statsr");
      const peerStats = expectShape(stats?.stats, isPeerStats, "peer stats");
      // One wall-clock pause, not four overlapping ones.
      expect(peerStats.pauses).toBe(1);
      expect(peerStats.pausedMs).toBeGreaterThanOrEqual(35);
      expect(peerStats.pausedMs).toBeLessThan(80);
      expect(peerStats.window?.messages).toBe(4);
      expect(peerStats.gateWaitMs?.samples).toBe(4);
      expect(peerStats.handleMs.samples).toBe(4);
      peer.stop();
    });
  }

  it("consumes in its handler, with no promise, when there is no slow consumer", () => {
    const { endpoint, sent, deliver } = fakeEndpoint();
    const peer = runPeer(endpoint, config("raw"));
    expect(deliver(encodeFrame(0, FLAG_SAMPLE, new Uint8Array(64)))).toBeUndefined();
    void deliver(JSON.stringify({ t: "barrier", id: 7 }));
    expect(sent).toEqual([
      { t: "ack", seq: 0 },
      { t: "credit", bytes: 72 },
      { t: "barrierr", id: 7, bytes: 64, messages: 1, lastSeq: 0 },
    ]);
    peer.stop();
  });
});

describe("runPeer rate-limited consumer", () => {
  // 64-byte payloads at 3200 B/s: 20 ms of service each.
  const rate = { bytesPerSec: 3200 };

  for (const variant of ["raw", "package"] as const) {
    it(`${variant}: consumes FIFO from one budget; ack, credit and the handler's promise come at consumption`, async () => {
      const { endpoint, sent, deliver } = fakeEndpoint();
      const peer = runPeer(endpoint, config(variant, undefined, rate));
      void deliver(JSON.stringify({ t: "measure" }));
      const start = performance.now();
      const settledAt: number[] = [];
      const held = [0, 1, 2].map((seq) => {
        const promise = deliver(encodeFrame(seq, FLAG_SAMPLE, new Uint8Array(64)));
        expect(promise).toBeInstanceOf(Promise);
        return Promise.resolve(promise).then(() => settledAt.push(performance.now() - start));
      });
      void deliver(JSON.stringify({ t: "barrier", id: 1 }));
      // An RPC is answered on arrival, ahead of the backlog.
      void deliver(JSON.stringify({ t: "rpc", id: 9, pad: "" }));
      expect(sent.map((m) => m.t)).toEqual(["rpcr"]);

      await held[0];
      // Only the first frame is consumed (and, raw, credited) when its promise settles.
      expect(sent.filter((m) => m.t === "ack").map((m) => m.seq)).toEqual([0]);
      // (The test window is 128 bytes, so the raw consumer returns credit after every frame.)
      expect(sent.filter((m) => m.t === "credit").reduce((n, m) => n + Number(m.bytes), 0)).toBe(
        variant === "raw" ? 72 : 0,
      );
      await Promise.all(held);
      // One after the other, 20 ms apart, never in parallel.
      expect(settledAt[0]).toBeGreaterThanOrEqual(15);
      expect(settledAt[1] - settledAt[0]).toBeGreaterThanOrEqual(15);
      expect(settledAt[2] - settledAt[1]).toBeGreaterThanOrEqual(15);
      expect(sent.filter((m) => m.t === "ack").map((m) => m.seq)).toEqual([0, 1, 2]);
      const credit = sent.filter((m) => m.t === "credit").reduce((n, m) => n + Number(m.bytes), 0);
      expect(credit).toBe(variant === "raw" ? 3 * 72 : 0);
      expect(sent.at(-1)).toMatchObject({ t: "barrierr", id: 1, bytes: 192, messages: 3, lastSeq: 2 });

      void deliver(JSON.stringify({ t: "stats" }));
      const stats = expectShape(sent.at(-1)?.stats, isPeerStats, "peer stats");
      expect(stats.consumer?.maxQueuedFrames).toBe(3);
      expect(stats.consumer?.endQueuedFrames).toBe(0);
      expect(stats.gateWaitMs?.samples).toBe(3);
      peer.stop();
    });
  }

  it("drops its backlog on a close and reports it, with its window stats, over the side channel", async () => {
    const { endpoint, deliver, remoteClose } = fakeEndpoint();
    let report: PeerCloseReport | undefined;
    const peer = runPeer(endpoint, config("package", undefined, rate), (r) => (report = r));
    void deliver(JSON.stringify({ t: "measure" }));
    const held = [0, 1, 2, 3].map((seq) => deliver(encodeFrame(seq, FLAG_SAMPLE, new Uint8Array(64))));
    await held[0];
    remoteClose({ code: 4008, reason: "overloaded" });
    // Every held handler is released by the drop, without being consumed.
    await Promise.all(held.map((promise) => Promise.resolve(promise)));
    await sleep(1_300);
    const checked = expectShape(report, isPeerCloseReport, "peer close report");
    expect(checked.code).toBe(4008);
    expect(checked.consumed.messages).toBe(1);
    expect(checked.droppedAtClose).toEqual({ bytes: 192, frames: 3 });
    expect(checked.stats.window?.messages).toBe(1);
    expect(checked.stats.consumer?.maxQueuedFrames).toBe(4);
    peer.stop();
  });
});
