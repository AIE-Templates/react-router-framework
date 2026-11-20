// Whether the macOS login session's screen is locked, for the scripts that launch the app and judge
// its windows: while it is locked, macOS sends no occlusion changes, so a window shown then gets no
// `show` event, and window-state changes such as entering full screen do not complete (measured:
// verify:release's startup smoke and the full-screen E2E failed only while the screen was locked).
// Runs on Node directly (type stripping).
import { execFileSync } from "node:child_process";

/** The session's state, or why it could not be read. Elsewhere than macOS, always unlocked. */
export type ScreenLock = { locked: boolean } | { unknown: string };

/**
 * Whether `ioreg -n Root -d1 -a` (an XML property list) says a session's screen is locked: its
 * `IOConsoleUsers` entries carry `CGSSessionScreenIsLocked` as `<true/>` while it is, and `<false/>` or
 * no such key otherwise. Any locked entry counts, as the console session is the one that matters and a
 * locked one elsewhere is at worst a false alarm.
 */
export function screenLockedFromIoreg(xml: string): boolean {
  return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\s*\/>/.test(xml);
}

/** The macOS screen lock, read from `ioreg` (an empty or failing listing is `unknown`). */
export function screenLock(
  platform: NodeJS.Platform = process.platform,
  ioreg: () => string = () =>
    execFileSync("ioreg", ["-n", "Root", "-d1", "-a"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }),
): ScreenLock {
  if (platform !== "darwin") return { locked: false };
  let xml: string;
  try {
    xml = ioreg();
  } catch (err) {
    return { unknown: `ioreg failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!xml.includes("IOConsoleUsers")) return { unknown: "ioreg listed no IOConsoleUsers" };
  return { locked: screenLockedFromIoreg(xml) };
}

/** The reason a window-state check cannot run now, with the key it was read from. */
export const SCREEN_LOCKED_REASON =
  "the macOS screen is locked (CGSSessionScreenIsLocked): while it is, macOS reports no window as shown " +
  "and completes no window-state change such as full screen";
