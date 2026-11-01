import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { documentHydrationScript, sseStreamed } from "./smoke.ts";

const options = { count: 4, interval: 100 };
const server = { events: 4, aborted: false, completed: true };

describe("sseStreamed", () => {
  it("passes events spread over the stream", () => {
    expect(sseStreamed({ events: [10, 110, 210, 310], endMs: 311, doneMs: 312, server }, options)).toBe(true);
  });

  it("fails events that arrived all at once at the end (buffered)", () => {
    expect(sseStreamed({ events: [300, 300, 301, 301], endMs: 301, doneMs: 302, server }, options)).toBe(false);
  });

  it("fails a stream cut short, aborted in the utility, or without its end event", () => {
    expect(sseStreamed({ events: [10, 110, 210], endMs: 311, doneMs: 312, server }, options)).toBe(false);
    expect(
      sseStreamed(
        { events: [10, 110, 210, 310], endMs: 311, doneMs: 312, server: { ...server, aborted: true } },
        options,
      ),
    ).toBe(false);
    expect(sseStreamed({ events: [10, 110, 210, 310], endMs: null, doneMs: 312, server }, options)).toBe(false);
    expect(
      sseStreamed(
        { events: [10, 110, 210, 310], endMs: 311, doneMs: 312, server: { ...server, completed: false } },
        options,
      ),
    ).toBe(false);
  });
});

describe("return-from-error renderer hydration check", () => {
  it.each<{ initial?: string; after?: string; expected: boolean }>([
    { expected: false },
    { initial: "false", expected: false },
    { initial: "true", expected: true },
    { after: "true", expected: true },
    { initial: "false", after: "true", expected: true },
  ])("requires an actual hydrated document: %j", async ({ initial, after, expected }) => {
    let elapsed = 0;
    const dataset = { hydrated: initial };
    const result: unknown = await runInNewContext(`(async () => { ${documentHydrationScript} })()`, {
      document: { documentElement: { dataset } },
      Date: { now: () => elapsed },
      setTimeout: (callback: () => void, ms: number) => {
        elapsed += ms;
        if (after !== undefined) dataset.hydrated = after;
        callback();
      },
    });
    expect(result).toBe(expected);
    expect(elapsed).toBe(expected ? (initial === "true" ? 0 : 25) : 5000);
  });
});
