import type { LinkName, RunConfig } from "../config.ts";
import type { LinkHandle } from "./link.ts";
import { setupRelay } from "./relay.ts";
import { setupSameThread } from "./same-thread.ts";
import { setupWorker } from "./worker.ts";
import { setupWs } from "./ws.ts";

export function setupLink(name: LinkName, config: RunConfig): Promise<LinkHandle> {
  switch (name) {
    case "same-thread":
      return setupSameThread(config);
    case "worker":
      return setupWorker(config);
    case "ws":
      return setupWs(config);
    case "relay":
      return setupRelay(config);
    default:
      throw new Error(`unknown link ${String(name)}`);
  }
}

export type { LinkHandle };
