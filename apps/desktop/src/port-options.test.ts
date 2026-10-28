import { describe, expect, it } from "vitest";

import { PORT_ACK_COALESCE, portAckCoalesce } from "./port-options.ts";

describe("portAckCoalesce", () => {
  it("keeps the default when unset, empty or 1", () => {
    expect(portAckCoalesce(undefined)).toBe(PORT_ACK_COALESCE);
    expect(portAckCoalesce("")).toBe(PORT_ACK_COALESCE);
    expect(portAckCoalesce("1")).toBe(PORT_ACK_COALESCE);
  });

  it("turns coalescing off with 0", () => {
    expect(portAckCoalesce("0")).toBe(false);
  });

  it("rejects anything else", () => {
    expect(() => portAckCoalesce("off")).toThrow(/DESKTOP_PORT_ACK_COALESCE/);
  });
});
