import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger, streamSink } from "./log.ts";

afterEach(() => vi.restoreAllMocks());

it("retains error diagnostics without leaking URL credentials or queries through message and stack", () => {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const error = new TypeError("fetch failed: https://user:password@example.test/api?token=secret#private");
  error.stack = `${error.name}: ${error.message}\n    at fetch (app://app/api.js?session=secret:1:2)\n    at retry`;
  createLogger().error({ err: error, status: 502 }, "request failed");
  const serialized = String(write.mock.calls[0][0]);
  const output = JSON.parse(serialized);
  expect(output).toMatchObject({
    level: "error",
    status: 502,
    msg: "request failed",
    err: {
      name: "TypeError",
      message: "fetch failed: https://example.test/api",
      stack: expect.stringContaining("at retry"),
    },
  });
  for (const privateValue of ["password", "token=", "session=", "secret", "#private"])
    expect(serialized).not.toContain(privateValue);
  expect(error.message).toContain("token=secret");
});

describe("stream sink", () => {
  class FakeStream extends EventEmitter {
    lines: string[] = [];
    throws = false;
    write(line: string): boolean {
      if (this.throws) throw new Error("EPIPE: broken pipe, write");
      this.lines.push(line);
      return true;
    }
  }

  it("drops lines once the stream failed, instead of letting the failure escape", () => {
    const stream = new FakeStream();
    const sink = streamSink(stream);
    sink("one\n");
    // An asynchronous write failure: with the sink's listener it is not an unhandled `error` event.
    expect(() => stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).not.toThrow();
    sink("two\n");
    expect(stream.lines).toEqual(["one\n"]);
  });

  it("treats a write that throws as a failed stream", () => {
    const stream = new FakeStream();
    const sink = streamSink(stream);
    stream.throws = true;
    expect(() => sink("one\n")).not.toThrow();
    stream.throws = false;
    sink("two\n");
    expect(stream.lines).toEqual([]);
  });
});
