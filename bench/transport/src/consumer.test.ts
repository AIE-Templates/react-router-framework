import { describe, expect, it } from "vitest";

import { type Clock, RateConsumer } from "./consumer.ts";

/** A clock that moves only when told to, firing due timers in time order. */
function manualClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return () => timers.delete(id);
    },
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
      await Promise.resolve();
    }
    now = end;
    await Promise.resolve();
  };
  /** Moves the clock by `ms` first, then fires every timer due by then: timers that run late. */
  const late = async (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers].toSorted((x, y) => x[1].at - y[1].at)) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.fn();
    }
    await Promise.resolve();
  };
  return { clock, advance, late };
}

describe("RateConsumer", () => {
  it("consumes FIFO from one shared budget: frames take turns, they are never served in parallel", async () => {
    const { clock, advance } = manualClock();
    const consumed: { item: string; at: number }[] = [];
    const consumer = new RateConsumer<string>({
      bytesPerSec: 1000, // 1 byte per ms
      clock,
      consume: (item) => consumed.push({ item, at: clock.now() }),
    });
    // Three 100-byte frames arrive together: 100 ms each, one after the other.
    for (const name of ["a", "b", "c"]) void consumer.pushFrame(name, 100);
    expect(consumer.queuedBytes).toBe(300);
    await advance(99);
    expect(consumed).toEqual([]);
    await advance(1);
    expect(consumed).toEqual([{ item: "a", at: 100 }]);
    await advance(150);
    expect(consumed.map((c) => c.at)).toEqual([100, 200]);
    await advance(50);
    expect(consumed).toEqual([
      { item: "a", at: 100 },
      { item: "b", at: 200 },
      { item: "c", at: 300 },
    ]);
    expect(consumer.queuedBytes).toBe(0);
    expect(consumer.maxQueuedFrames).toBe(3);
  });

  it("settles each frame's promise when that frame is consumed, not before and not with the batch", async () => {
    const { clock, advance } = manualClock();
    const consumed: string[] = [];
    const consumer = new RateConsumer<string>({ bytesPerSec: 1000, clock, consume: (item) => consumed.push(item) });
    const settled: string[] = [];
    for (const name of ["a", "b"]) {
      const promise = consumer.pushFrame(name, 50);
      expect(promise).toBeInstanceOf(Promise);
      void promise?.then(() => settled.push(`${name} (consumed: ${consumed.join(",")})`));
    }
    await advance(49);
    expect(settled).toEqual([]);
    await advance(1);
    expect(settled).toEqual(["a (consumed: a)"]);
    await advance(50);
    expect(settled).toEqual(["a (consumed: a)", "b (consumed: a,b)"]);
  });

  it("keeps the rate on a virtual clock: a late timer catches up instead of losing time", async () => {
    const { clock, advance, late } = manualClock();
    const consumed: number[] = [];
    const consumer = new RateConsumer<number>({ bytesPerSec: 1000, clock, consume: () => consumed.push(clock.now()) });
    for (let i = 0; i < 4; i++) void consumer.pushFrame(i, 10);
    // The timer due at 10 fires 25 ms late (an event loop busy elsewhere): every frame due by then goes at once.
    await late(35);
    expect(consumed).toEqual([35, 35, 35]);
    await advance(5);
    expect(consumed).toEqual([35, 35, 35, 40]);
  });

  it("an idle worker still charges a frame its service time; control items queue behind frames", async () => {
    const { clock, advance } = manualClock();
    const order: string[] = [];
    const consumer = new RateConsumer<string>({ bytesPerSec: 1000, clock, consume: (item) => order.push(item) });
    consumer.pushControl("barrier-0");
    expect(order).toEqual(["barrier-0"]);
    expect(consumer.pushFrame("frame", 20)).toBeInstanceOf(Promise);
    consumer.pushControl("barrier-1");
    expect(order).toEqual(["barrier-0"]);
    await advance(20);
    expect(order).toEqual(["barrier-0", "frame", "barrier-1"]);
  });

  it("recovers from `unlimitedFrom` on: the queue empties at once and later frames are consumed in the handler", async () => {
    const { clock, advance } = manualClock();
    const consumed: string[] = [];
    let idle = 0;
    const consumer = new RateConsumer<string>({
      bytesPerSec: 1000,
      clock,
      consume: (item) => consumed.push(item),
      onIdle: () => idle++,
    });
    for (const name of ["a", "b", "c"]) void consumer.pushFrame(name, 100);
    consumer.unlimitedFrom(150);
    await advance(150);
    expect(consumed).toEqual(["a"]);
    consumer.pump();
    // "b" started at 100, before recovery, so it finishes its own time; "c" costs nothing after it.
    expect(consumed).toEqual(["a"]);
    await advance(50);
    expect(consumed).toEqual(["a", "b", "c"]);
    expect(idle).toBe(1);
    expect(consumer.pushFrame("d", 100)).toBeUndefined();
    expect(consumed.at(-1)).toBe("d");
  });

  it("drop() releases every held frame unconsumed and ignores later arrivals", async () => {
    const { clock, advance } = manualClock();
    const consumed: string[] = [];
    const consumer = new RateConsumer<string>({ bytesPerSec: 1000, clock, consume: (item) => consumed.push(item) });
    const held = ["a", "b"].map((name) => consumer.pushFrame(name, 100));
    expect(consumer.drop()).toEqual({ bytes: 200, frames: 2 });
    await Promise.all(held.map((promise) => Promise.resolve(promise)));
    await advance(500);
    expect(consumed).toEqual([]);
    expect(consumer.pushFrame("c", 1)).toBeUndefined();
    expect(consumed).toEqual([]);
  });
});
