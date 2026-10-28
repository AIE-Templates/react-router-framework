// @vitest-environment node
import { pino } from "pino";
import { describe, expect, it } from "vitest";

import { logRejection } from "./logger";

function captureLogs() {
  const lines: string[] = [];
  return { lines, log: pino({}, { write: (line: string) => lines.push(line) }) };
}

describe("logRejection", () => {
  it("logs a rejection and passes it on", async () => {
    const { lines, log } = captureLogs();

    await expect(logRejection(Promise.reject(new Error("deferred boom")), { log })).rejects.toThrow("deferred boom");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("deferred boom");
    expect(lines[0]).toContain("deferred data failed");
  });

  it("passes values through without logging", async () => {
    const { lines, log } = captureLogs();

    await expect(logRejection(Promise.resolve(42), { log })).resolves.toBe(42);
    expect(lines).toEqual([]);
  });

  it("skips rejections from requests the user aborted", async () => {
    const { lines, log } = captureLogs();
    const controller = new AbortController();
    controller.abort();

    await expect(
      logRejection(Promise.reject(new Error("aborted")), { log, signal: controller.signal }),
    ).rejects.toThrow("aborted");
    expect(lines).toEqual([]);
  });
});
