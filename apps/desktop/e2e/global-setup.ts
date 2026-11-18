import { targetProcesses, type Target } from "./desktop.ts";

const targets: Target[] = ["unpackaged", "packaged"];

/** Refuses to start while an Electron of this checkout runs: the teardown could not tell them apart. */
export default function globalSetup(): () => void {
  for (const target of targets) {
    const running = targetProcesses(target);
    if (running.length > 0) {
      throw new Error(`the ${target} app is already running (pids ${running.join(", ")}); quit it first`);
    }
  }
  // Teardown: every launched app must be gone, its helpers (renderer, GPU, utility) included.
  return () => {
    const left = targets.flatMap((target) => targetProcesses(target));
    if (left.length === 0) {
      process.stdout.write("e2e: no Electron process left running\n");
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
