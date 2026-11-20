import { SCREEN_LOCKED_REASON, screenLock } from "../scripts/session-state.ts";
import { targetProcesses, type Target } from "./desktop.ts";

const targets: Target[] = ["unpackaged", "packaged"];

const running = () => targets.flatMap((target) => targetProcesses(target));

/** Refuses to start while an Electron of this checkout runs: the teardown could not tell them apart. */
export default function globalSetup(): () => Promise<void> {
  // A locked macOS session makes window-state tests fail in ways that look like app defects (no
  // `show` event, full screen never entered): stop before any test instead.
  const lock = screenLock();
  if ("locked" in lock && lock.locked) {
    throw new Error(
      `e2e: not run: ${SCREEN_LOCKED_REASON}, so tests of window visibility, focus and full screen (the ` +
        "navigation and window tests among them) cannot pass truthfully. Unlock the screen and run again.",
    );
  }
  for (const target of targets) {
    const instances = targetProcesses(target);
    if (instances.length > 0) {
      throw new Error(`the ${target} app is already running (pids ${instances.join(", ")}); quit it first`);
    }
  }
  // Teardown: every launched app must be gone, its helpers (renderer, GPU, utility) included.
  return async () => {
    let left = running();
    const until = Date.now() + 5000;
    while (left.length && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      left = running();
    }
    if (left.length === 0) {
      process.stdout.write("e2e: no Electron process left running\n");
      return;
    }
    // A path match may be an independently started instance. Each fixture cleans up the launch it owns.
    throw new Error(`Electron processes still running after the e2e run: ${left.join(", ")}`);
  };
}
