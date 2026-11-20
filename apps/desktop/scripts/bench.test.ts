import { describe, expect, it } from "vitest";

import { checkRunMarkers, type RunMarker } from "./bench.ts";

const unflipped = "RunAsNode=true EnableCookieEncryption=false";
const flipped = "RunAsNode=false EnableCookieEncryption=true";
const packaged: RunMarker = { target: "packaged", fuses: flipped };

describe("bench run markers", () => {
  it("accepts runs measured on one target with one set of fuses, across files", () => {
    expect(() =>
      checkRunMarkers(
        new Map([
          ["a.jsonl", [packaged, packaged]],
          ["b.jsonl", [packaged]],
        ]),
        packaged,
      ),
    ).not.toThrow();
    expect(() => checkRunMarkers(new Map([["empty.jsonl", []]]), packaged)).not.toThrow();
  });

  it("refuses to compare runs from before and after the fuse change, or from another target", () => {
    expect(() =>
      checkRunMarkers(
        new Map([
          ["before.jsonl", [{ target: "packaged", fuses: unflipped }]],
          ["after.jsonl", [packaged]],
        ]),
      ),
    ).toThrow(/different targets or fuses:\n {2}before\.jsonl: packaged, RunAsNode=true.*\n {2}after\.jsonl: packaged/);
    expect(() =>
      checkRunMarkers(new Map([["mixed.jsonl", [packaged, { target: "unpackaged", fuses: flipped }]]])),
    ).toThrow("different targets or fuses");
  });

  it("refuses to append to a file of runs measured on something else", () => {
    expect(() =>
      checkRunMarkers(new Map([["out.jsonl", [{ target: "unpackaged", fuses: unflipped }]]]), packaged),
    ).toThrow(/this run: packaged, RunAsNode=false.*\n {2}out\.jsonl: unpackaged/);
  });

  it("refuses runs written before markers existed", () => {
    expect(() => checkRunMarkers(new Map([["old.jsonl", [{}]]]))).toThrow(
      "old.jsonl holds runs without a target and fuse marker",
    );
    expect(() => checkRunMarkers(new Map([["half.jsonl", [{ target: "packaged" }]]]), packaged)).toThrow(
      "without a target and fuse marker",
    );
  });
});
