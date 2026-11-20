// Whether the macOS login session's screen is locked, for the scripts that launch the app and judge
// its windows: while it is locked, macOS sends no occlusion changes, so a window shown then gets no
// `show` event, and window-state changes such as entering full screen do not complete (measured:
// verify:release's startup smoke and the full-screen E2E failed only while the screen was locked).
// Runs on Node directly (type stripping).
import { execFileSync } from "node:child_process";

/** The session's state, or why it could not be read. Elsewhere than macOS, always unlocked. */
export type ScreenLock = { locked: boolean } | { unknown: string };

function consoleSessions(): unknown {
  const xml = execFileSync("ioreg", ["-n", "Root", "-d1", "-a"], { maxBuffer: 16 * 1024 * 1024 });
  const json = execFileSync("plutil", ["-extract", "IOConsoleUsers", "json", "-o", "-", "-"], {
    input: xml,
    encoding: "utf8",
  });
  return JSON.parse(json);
}

/** Only the frontmost login session can determine whether window-state checks can run. */
export function screenLock(platform: NodeJS.Platform = process.platform, sessions = consoleSessions): ScreenLock {
  if (platform !== "darwin") return { locked: false };
  try {
    const listing: unknown = sessions();
    if (Array.isArray(listing)) {
      for (const entry of listing as unknown[]) {
        if (
          typeof entry === "object" &&
          entry !== null &&
          "kCGSSessionOnConsoleKey" in entry &&
          entry.kCGSSessionOnConsoleKey === true
        ) {
          return { locked: "CGSSessionScreenIsLocked" in entry && entry.CGSSessionScreenIsLocked === true };
        }
      }
    }
    return { unknown: "ioreg listed no foreground console session" };
  } catch (err) {
    return { unknown: `could not read IOConsoleUsers: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The reason a window-state check cannot run now, with the key it was read from. */
export const SCREEN_LOCKED_REASON =
  "the macOS screen is locked (CGSSessionScreenIsLocked): while it is, macOS reports no window as shown " +
  "and completes no window-state change such as full screen";
