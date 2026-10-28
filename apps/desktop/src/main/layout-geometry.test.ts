import { describe, expect, it } from "vitest";

import { checkHeaderRegion, snapBorderWidth } from "./layout-geometry.ts";

describe("snapBorderWidth", () => {
  it.each([
    [1, 1],
    [1.25, 0.8],
    [1.5, 2 / 3],
    [1.75, 1 / 1.75],
    [2, 1],
    [2.5, 0.8],
    [3, 1],
  ])("snaps a 1px border to whole device pixels at scale %s", (scale, expected) => {
    expect(snapBorderWidth(1, scale)).toBeCloseTo(expected, 6);
  });
  it("keeps at least one device pixel and rounds wider borders down", () => {
    expect(snapBorderWidth(0.5, 1)).toBe(1);
    expect(snapBorderWidth(0.2, 2)).toBe(0.5);
    expect(snapBorderWidth(2, 1.25)).toBe(1.6);
    expect(snapBorderWidth(0, 1.25)).toBe(0);
  });
});

/** Windows native-overlay: a 48px overlay, a 48px body and a 1px separator. */
const windows = (devicePixelRatio: number) => ({
  expectedWindowHeight: 49,
  separator: 1,
  safeBottom: 48,
  devicePixelRatio,
});

describe("checkHeaderRegion", () => {
  it.each([1, 1.25, 1.5, 1.75, 2])(
    "accepts a 49px fused Windows header whose snapped separator sits below the overlay at scale %s",
    (scale) => {
      const border = snapBorderWidth(1, scale);
      expect(checkHeaderRegion({ expected: "drag", height: 49, border }, windows(scale))).toMatchObject({
        expectedHeight: 49,
        aligned: true,
      });
    },
  );
  it("rejects the Windows header when its separator is missing, too wide or overlaps the overlay", () => {
    expect(checkHeaderRegion({ expected: "drag", height: 49, border: 0 }, windows(1.25)).aligned).toBe(false);
    expect(checkHeaderRegion({ expected: "drag", height: 49, border: 1 }, windows(1.25)).aligned).toBe(false);
    expect(checkHeaderRegion({ expected: "drag", height: 49, border: 2 }, windows(1)).aligned).toBe(false);
    expect(
      checkHeaderRegion({ expected: "drag", height: 49, border: 1 }, { ...windows(1), safeBottom: 48.5 }).aligned,
    ).toBe(false);
  });
  it("rejects a fused header that wrapped or does not reach the band height", () => {
    expect(checkHeaderRegion({ expected: "drag", height: 78, border: 0.8 }, windows(1.25)).aligned).toBe(false);
    expect(checkHeaderRegion({ expected: "drag", height: 48, border: 1 }, windows(1)).aligned).toBe(false);
  });
  it("checks only the height without a separator (macOS, Linux)", () => {
    const geometry = { expectedWindowHeight: 48, separator: 0, safeBottom: 36, devicePixelRatio: 2 };
    expect(checkHeaderRegion({ expected: "drag", height: 48, border: 0.5 }, geometry)).toEqual({
      expectedHeight: 48,
      aligned: true,
    });
    expect(checkHeaderRegion({ expected: "drag", height: 49, border: 0.5 }, geometry).aligned).toBe(false);
  });
  it("requires headers outside the band to be at least the shell header height", () => {
    const geometry = windows(1.25);
    expect(checkHeaderRegion({ expected: "no-drag", height: 50.4, border: 0.8 }, geometry)).toEqual({
      expectedHeight: 48,
      aligned: true,
    });
    expect(checkHeaderRegion({ expected: "no-drag", height: 47, border: 0.8 }, geometry).aligned).toBe(false);
  });
});
