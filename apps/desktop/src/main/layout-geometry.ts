/** Pure expectations for the layout smoke's top-band measurements (CSS px, as the renderer reports them). */

/** The shell header height (`--shell-header-height: 3rem` at the default font size). */
export const SHELL_HEADER_HEIGHT = 48;

// Chromium positions boxes in 1/64 px layout units; a measured height can be off by that much.
const LAYOUT_UNIT = 1 / 64;

/**
 * The used width Chromium gives a border of `cssPx` at `devicePixelRatio` (CSS Backgrounds 3, "snap as a
 * border width"): whole device pixels, rounded down, but at least one. A 1px border is 0.8 CSS px at 1.25,
 * 0.667 at 1.5 and 1 at 1 or 2; `getComputedStyle()` reports this snapped value.
 */
export function snapBorderWidth(cssPx: number, devicePixelRatio: number): number {
  if (!(cssPx > 0) || !(devicePixelRatio > 0)) return 0;
  const devicePixels = cssPx * devicePixelRatio;
  return (devicePixels < 1 ? 1 : Math.floor(devicePixels + 1e-6)) / devicePixelRatio;
}

export interface TopBandGeometry {
  /** `max(48, WCO bottom)` plus the Windows separator: the height the window's top band must have. */
  expectedWindowHeight: number;
  /** The specified separator width in CSS px (1 on Windows native-overlay, else 0). */
  separator: number;
  /** Bottom of the WCO titlebar area, or 0 when there is no visible overlay. */
  safeBottom: number;
  devicePixelRatio: number;
}

export interface HeaderRegionMeasurement {
  /** The app-region the header should have: `drag` when it is part of the fused window band. */
  expected: "drag" | "no-drag";
  height: number;
  /** Computed `border-block-end-width`, already snapped to device pixels by Chromium. */
  border: number;
}

/**
 * Whether a module header lines up with the window band (LAY-04, LAY-06): a fused (drag) header is
 * exactly the band's height, and on Windows its separator is the snapped 1px border lying entirely
 * below the native overlay. Headers outside the band only need the shell header height.
 */
export function checkHeaderRegion(
  region: HeaderRegionMeasurement,
  geometry: TopBandGeometry,
): { expectedHeight: number; expectedBorder?: number; aligned: boolean } {
  if (region.expected !== "drag")
    return { expectedHeight: SHELL_HEADER_HEIGHT, aligned: region.height >= SHELL_HEADER_HEIGHT - LAYOUT_UNIT };
  const expectedHeight = geometry.expectedWindowHeight;
  const heightMatches = Math.abs(region.height - expectedHeight) < 0.5;
  if (geometry.separator === 0) return { expectedHeight, aligned: heightMatches };
  const expectedBorder = snapBorderWidth(geometry.separator, geometry.devicePixelRatio);
  const separatorBelowOverlay =
    Math.abs(region.border - expectedBorder) < 0.01 &&
    region.height - region.border >= geometry.safeBottom - LAYOUT_UNIT;
  return { expectedHeight, expectedBorder, aligned: heightMatches && separatorBelowOverlay };
}
