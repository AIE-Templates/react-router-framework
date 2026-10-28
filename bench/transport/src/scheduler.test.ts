import { MessageChannel } from "node:worker_threads";

import { describe, expect, it } from "vitest";

import { Scheduler } from "./scheduler.ts";

/** Spins for `ms`, standing in for encoding and a synchronous socket write. */
function spin(ms: number): void {
  const start = performance.now();
  while (performance.now() - start < ms) {
    // busy
  }
}

/**
 * A bulk run (no admission wait, nothing due later) of `runMs`, while a MessagePort ping-pongs
 * with itself: returns the scheduler's stats and the longest wait of a message for delivery.
 */
async function burstWithMessages(budget: { bytes: number; ms: number }, runMs: number) {
  const scheduler = new Scheduler({ ratePerSec: 0, frameBytes: 1024, budget });
  const { port1, port2 } = new MessageChannel();
  let postedAt = 0;
  let maxDelay = 0;
  let delivered = 0;
  port2.on("message", () => {
    const delay = performance.now() - postedAt;
    if (delay > maxDelay) maxDelay = delay;
    delivered++;
    postedAt = performance.now();
    port1.postMessage(0);
  });
  // Let the port start listening before the burst.
  await new Promise((resolve) => setTimeout(resolve, 5));
  postedAt = performance.now();
  port1.postMessage(0);
  await scheduler.run(() => spin(0.05), performance.now() + runMs);
  const pendingDelay = performance.now() - postedAt;
  port1.close();
  port2.close();
  return { stats: scheduler.stats(), maxDelay: Math.max(maxDelay, pendingDelay), delivered };
}

describe("Scheduler", () => {
  it("keeps the timetable and measures latency from the intended time", async () => {
    const scheduler = new Scheduler({ ratePerSec: 1000, maxFrames: 50 });
    const deadline = performance.now() + 5000;
    await scheduler.run((frame) => {
      // Complete 5 ms later, as an acknowledgement would.
      setTimeout(() => scheduler.complete(frame.seq), 5);
    }, deadline);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const stats = scheduler.stats();
    expect(stats.offered).toBe(50);
    expect(stats.sent).toBe(50);
    expect(stats.completed).toBe(50);
    expect(stats.fromIntended.p50Ms).toBeGreaterThanOrEqual(4);
    expect(stats.generatorLimited).toBe(false);
  });

  it("with stopAtDeadline, stops at the deadline and counts what was due but never sent", async () => {
    const scheduler = new Scheduler({ ratePerSec: 1000, stopAtDeadline: true });
    const start = performance.now();
    // Admission blocks for 30 ms on the first frame: about 30 frames fall due meanwhile.
    await scheduler.run(
      () => {},
      start + 20,
      (frame) => (frame.seq === 0 ? new Promise((resolve) => setTimeout(resolve, 30)) : undefined),
    );
    const stats = scheduler.stats();
    expect(performance.now() - start).toBeLessThan(60);
    expect(stats.sent).toBe(1);
    expect(stats.abandoned).toBeGreaterThanOrEqual(19);
    expect(stats.abandoned).toBeLessThanOrEqual(22);
    expect(scheduler.startedAt).toBeGreaterThanOrEqual(start);
  });

  it("censors frames still pending when the run is cut short, at their age, instead of dropping them", async () => {
    const scheduler = new Scheduler({ ratePerSec: 0, maxFrames: 4 });
    await scheduler.run(() => {}, performance.now() + 5000);
    scheduler.complete(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    scheduler.censor(performance.now());
    expect(scheduler.pendingCount).toBe(0);
    const stats = scheduler.stats();
    expect(stats.completed).toBe(1);
    expect(stats.censored).toBe(3);
    expect(stats.fromIntended.samples).toBe(4);
    expect(stats.fromIntended.p99Ms).toBeGreaterThanOrEqual(25);
  });

  it("records lateness when admission blocks the sender", async () => {
    const scheduler = new Scheduler({ ratePerSec: 1000, maxFrames: 10, lateThresholdMs: 1 });
    await scheduler.run(
      (frame) => scheduler.complete(frame.seq),
      performance.now() + 5000,
      (frame) => (frame.seq === 0 ? new Promise((resolve) => setTimeout(resolve, 20)) : undefined),
    );
    const stats = scheduler.stats();
    expect(stats.late).toBeGreaterThan(0);
    expect(stats.maxLatenessMs).toBeGreaterThanOrEqual(15);
  });

  it("tracks only sampled frames, so unsampled ones never count as timed out", async () => {
    const scheduler = new Scheduler({ ratePerSec: 0, maxFrames: 64, sampleEvery: 16, timeoutMs: 1 });
    await scheduler.run(() => {}, performance.now() + 5000);
    expect(scheduler.pendingCount).toBe(4);
    scheduler.complete(0);
    scheduler.complete(16);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const stats = scheduler.stats();
    expect(stats.sent).toBe(64);
    expect(stats.completed).toBe(2);
    expect(stats.timedOut).toBe(2);
  });

  it("starts fromSent at admission, so the synchronous send cost is inside it, not in lateness", async () => {
    const scheduler = new Scheduler({ ratePerSec: 0, maxFrames: 1, lateThresholdMs: 1 });
    await scheduler.run(
      (frame) => {
        const start = performance.now();
        while (performance.now() - start < 10) {
          // Stands in for encoding and a structured clone.
        }
        setTimeout(() => scheduler.complete(frame.seq), 5);
      },
      performance.now() + 5000,
      () => new Promise((resolve) => setTimeout(resolve, 20)),
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    const stats = scheduler.stats();
    expect(stats.latenessMs.maxMs).toBeGreaterThanOrEqual(19);
    expect(stats.sendCostMs.maxMs).toBeGreaterThanOrEqual(10);
    // Node timers run on millisecond loop time, so the 5 ms acknowledgement can land a little early.
    expect(stats.fromSent.maxMs).toBeGreaterThanOrEqual(14);
    expect(stats.fromIntended.maxMs).toBeGreaterThanOrEqual(35);
  });

  it("tracks a frame before sending it, so a completion during send is not lost", async () => {
    const scheduler = new Scheduler({ ratePerSec: 0, maxFrames: 3 });
    await scheduler.run((frame) => scheduler.complete(frame.seq), performance.now() + 5000);
    const stats = scheduler.stats();
    expect(stats.completed).toBe(3);
    expect(scheduler.pendingCount).toBe(0);
  });

  describe("cooperative send loop", () => {
    it("yields a macrotask turn within the budget, so the thread's own messages are handled", async () => {
      const { stats, maxDelay, delivered } = await burstWithMessages({ bytes: 64 * 1024, ms: 2 }, 200);
      expect(stats.sent).toBeGreaterThan(100);
      expect(stats.yields).toBeGreaterThan(20);
      // Messages get through during the burst. Wall-clock bounds stay loose (half the 200 ms run):
      // the OS, GC or a busy machine can stall the thread past any tight budget; the no-budget
      // counterpart below holds them for the whole run.
      expect(delivered).toBeGreaterThan(20);
      expect(stats.maxBurstMs).toBeLessThan(100);
      expect(maxDelay).toBeLessThan(100);
    });

    it("without a budget, the same burst starves the message for the whole run", async () => {
      const { stats, maxDelay, delivered } = await burstWithMessages({ bytes: 1e15, ms: 1e9 }, 100);
      expect(stats.yields).toBe(0);
      expect(stats.maxBurstMs).toBeGreaterThanOrEqual(95);
      expect(delivered).toBe(0);
      expect(maxDelay).toBeGreaterThanOrEqual(95);
    });

    it("yields on the byte budget too, and a real wait ends a burst without a forced yield", async () => {
      const bytes = new Scheduler({
        ratePerSec: 0,
        maxFrames: 8,
        frameBytes: 64 * 1024,
        budget: { bytes: 64 * 1024, ms: 1e9 },
      });
      await bytes.run(() => {}, performance.now() + 5000);
      expect(bytes.stats().yields).toBe(8);

      // Admission waits on a timer before every frame: each wait is a turn, so no yield is forced.
      const waiting = new Scheduler({ ratePerSec: 0, maxFrames: 8, frameBytes: 1024 });
      await waiting.run(
        () => {},
        performance.now() + 5000,
        () => new Promise((resolve) => setTimeout(resolve, 1)),
      );
      expect(waiting.stats().yields).toBe(0);
      expect(waiting.stats().maxBurstMs).toBeLessThan(5);
    });
  });
});
