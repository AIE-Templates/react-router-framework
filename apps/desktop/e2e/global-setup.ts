import { pgrep, processRoot, type Target } from "./desktop.ts";

const targets: Target[] = ["unpackaged", "packaged"];

/** Refuses to start while an Electron of this checkout runs: the teardown could not tell them apart. */
export default function globalSetup(): () => void {
  for (const target of targets) {
    const running = pgrepTarget(target);
    if (running.length > 0) {
      throw new Error(`the ${target} app is already running (pids ${running.join(", ")}); quit it first`);
    }
  }
  // Teardown: every launched app must be gone, its helpers (renderer, GPU, utility) included.
  return () => {
    const left = targets.flatMap((target) => pgrepTarget(target));
    if (left.length === 0) {
      process.stdout.write("e2e: no Electron process left running (pgrep)\n");
      return;
    }
    for (const pid of left) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone in the meantime.
      }
    }
    throw new Error(`Electron processes outlived the e2e run and were killed: ${left.join(", ")}`);
  };
}

function pgrepTarget(target: Target): number[] {
  return pgrep(processRoot(target));
}
