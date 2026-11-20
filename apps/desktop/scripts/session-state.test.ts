import { describe, expect, it } from "vitest";

import { screenLock, screenLockedFromIoreg } from "./session-state.ts";

/** The part of `ioreg -n Root -d1 -a` that matters, shaped as macOS prints it. */
function listing(entry: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>IOConsoleUsers</key>
	<array>
		<dict>
			<key>CGSSessionScreenLockedTime</key>
			<integer>1795177170</integer>
${entry}
			<key>kCGSSessionOnConsoleKey</key>
			<true/>
		</dict>
	</array>
</dict>
</plist>
`;
}

function fail(): never {
  throw new Error("ioreg: command not found");
}

describe("screen lock", () => {
  it("reads the lock from ioreg's CGSSessionScreenIsLocked", () => {
    expect(screenLockedFromIoreg(listing("\t\t\t<key>CGSSessionScreenIsLocked</key>\n\t\t\t<true/>"))).toBe(true);
    expect(screenLockedFromIoreg(listing("\t\t\t<key>CGSSessionScreenIsLocked</key>\n\t\t\t<false/>"))).toBe(false);
    // Unlocked sessions often carry no such key at all.
    expect(screenLockedFromIoreg(listing(""))).toBe(false);
    // Another key's value is not the lock.
    expect(screenLockedFromIoreg(listing("\t\t\t<key>kCGSSessionSystemSafeBoot</key>\n\t\t\t<true/>"))).toBe(false);
  });

  it("is a no-op elsewhere than macOS and says when it cannot tell", () => {
    expect(screenLock("linux", fail)).toEqual({ locked: false });
    expect(screenLock("win32", fail)).toEqual({ locked: false });
    expect(screenLock("darwin", fail)).toEqual({ unknown: "ioreg failed: ioreg: command not found" });
    expect(screenLock("darwin", () => "")).toEqual({ unknown: "ioreg listed no IOConsoleUsers" });
    expect(screenLock("darwin", () => listing("\t\t\t<key>CGSSessionScreenIsLocked</key>\n\t\t\t<true/>"))).toEqual({
      locked: true,
    });
  });

  it.runIf(process.platform === "darwin")("reads this Mac's real listing", () => {
    expect(screenLock()).toHaveProperty("locked");
  });
});
