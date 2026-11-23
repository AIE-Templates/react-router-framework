import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mergePackageJson } from "./package-merge.ts";

const json = (value: unknown) => JSON.stringify(value);

describe("mergePackageJson", () => {
  it("merges neighbouring dependency changes from both sides, sorted", () => {
    const base = json({
      dependencies: { "@react-router/serve": "^8.5.0", isbot: "^5.1.36", react: "^19" },
    });
    // ours removed serve and added a workspace package; theirs bumped isbot.
    const ours = json({
      dependencies: { "@repo/shared": "workspace:*", isbot: "^5.1.36", react: "^19" },
    });
    const theirs = json({
      dependencies: { "@react-router/serve": "^8.5.0", isbot: "^5.1.37", react: "^19" },
    });

    const result = mergePackageJson([base], ours, theirs);

    assert.deepEqual(result, {
      ok: true,
      value: { dependencies: { "@repo/shared": "workspace:*", isbot: "^5.1.37", react: "^19" } },
    });
    assert.deepEqual(Object.keys((result as { value: { dependencies: object } }).value.dependencies), [
      "@repo/shared",
      "isbot",
      "react",
    ]);
  });

  it("keeps our key order and appends keys only theirs added", () => {
    const result = mergePackageJson(
      [json({ name: "a" })],
      json({ name: "a", type: "module" }),
      json({ private: true, name: "a" }),
    );

    assert.ok(result.ok);
    assert.deepEqual(Object.keys(result.value as object), ["name", "type", "private"]);
  });

  it("reports a key both sides changed differently", () => {
    const result = mergePackageJson(
      [json({ scripts: { start: "a" } })],
      json({ scripts: { start: "b" } }),
      json({ scripts: { start: "c" } }),
    );

    assert.deepEqual(result, {
      ok: false,
      conflicts: [{ path: "scripts.start", reason: "both-changed" }],
    });
  });

  it("reports a key one side deleted and the other changed", () => {
    const result = mergePackageJson(
      [json({ dependencies: { serve: "^1" } })],
      json({ dependencies: {} }),
      json({ dependencies: { serve: "^2" } }),
    );

    assert.deepEqual(result, {
      ok: false,
      conflicts: [{ path: "dependencies.serve", reason: "delete-modify" }],
    });
  });

  it("takes a deletion when the other side left the key alone", () => {
    const result = mergePackageJson(
      [json({ files: ["build"], x: 1 })],
      json({ x: 1 }),
      json({ files: ["build"], x: 2 }),
    );

    assert.deepEqual(result, { ok: true, value: { x: 2 } });
  });

  it("treats arrays as values", () => {
    const result = mergePackageJson([json({ files: ["a"] })], json({ files: ["a", "b"] }), json({ files: ["a", "c"] }));

    assert.deepEqual(result, { ok: false, conflicts: [{ path: "files", reason: "both-changed" }] });
  });

  it("merges a file both sides added", () => {
    const result = mergePackageJson([undefined], json({ name: "x", a: 1 }), json({ name: "x", b: 2 }));

    assert.deepEqual(result, { ok: true, value: { name: "x", a: 1, b: 2 } });
  });

  it("merges a criss-cross: a combination merging its second upstream after the first took a new base", () => {
    // app/static/core already merged the new starter/static (serve removed, isbot bumped); now the new
    // app/base/core arrives (shared added earlier, isbot bumped too). Bases: the old core and the new base.
    const oldCore = json({
      dependencies: {
        "@react-router/serve": "^8",
        "@repo/shared": "workspace:*",
        isbot: "^5.1.36",
      },
    });
    const newBase = json({ dependencies: { "@react-router/serve": "^8", isbot: "^5.1.37" } });
    const ours = json({ dependencies: { "@repo/shared": "workspace:*", isbot: "^5.1.37" } });
    const theirs = json({
      dependencies: {
        "@react-router/serve": "^8",
        "@repo/shared": "workspace:*",
        isbot: "^5.1.37",
      },
    });

    assert.deepEqual(mergePackageJson([oldCore, newBase], ours, theirs), {
      ok: true,
      value: { dependencies: { "@repo/shared": "workspace:*", isbot: "^5.1.37" } },
    });
  });

  it("reports a key each side left at a different base's value", () => {
    const result = mergePackageJson([json({ v: 1 }), json({ v: 2 })], json({ v: 1 }), json({ v: 2 }));

    assert.deepEqual(result, { ok: false, conflicts: [{ path: "v", reason: "both-changed" }] });
  });
});
