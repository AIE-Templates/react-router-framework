import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { enabledOrder, type Topology } from "./topology.ts";

const node = (name: string, upstreams: string[] = [], enabled = true) => ({
  name,
  upstreams,
  enabled,
});

describe("enabledOrder", () => {
  it("orders the checked-in topology with every upstream first, planned branches left out", () => {
    const topology = JSON.parse(readFileSync(new URL("./topology.json", import.meta.url), "utf8")) as Topology;

    const order = enabledOrder(topology).map((branch) => branch.name);

    assert.deepEqual(order, [
      "starter/base",
      "starter/static",
      "starter/fullstack",
      "app/base/core",
      "app/static/core",
      "app/fullstack/core",
      "app/base/mantine",
      "app/static/mantine",
      "app/fullstack/mantine",
      "platform/electron/core",
      "platform/electron/mantine",
    ]);
  });

  it("rejects an upstream that is not listed", () => {
    assert.throws(() => enabledOrder({ branches: [node("a", ["missing"])] }), /not listed/);
  });

  it("rejects an enabled branch that merges a planned one", () => {
    assert.throws(() => enabledOrder({ branches: [node("a", [], false), node("b", ["a"])] }), /not enabled/);
  });

  it("rejects a cycle, also among planned branches", () => {
    assert.throws(
      () => enabledOrder({ branches: [node("a", ["b"], false), node("b", ["a"], false)] }),
      /cycle among a, b/,
    );
  });

  it("rejects a branch listed twice", () => {
    assert.throws(() => enabledOrder({ branches: [node("a"), node("a")] }), /twice/);
  });
});
