import { MessagePort, parentPort, workerData } from "node:worker_threads";

import { expect, isRecord, isRunConfig } from "../guards.ts";
import { sourcePackages } from "../packages.ts";
import { startPortPeer } from "./link.ts";

sourcePackages();

// The worker side of the `worker` link: run the peer on the transferred port until terminated.
const data = expect(workerData, isRecord, "worker data");
const config = expect(data.config, isRunConfig, "run config");
const port = data.port;
if (!(port instanceof MessagePort)) throw new Error("worker data has no port");
// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a message port, not a window
startPortPeer(port, config, (report) => parentPort?.postMessage({ peerClose: report }));
