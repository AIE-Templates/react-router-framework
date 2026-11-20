import type { AckCoalesceOptions } from "@repo/port-fetch";

/**
 * Ack coalescing for the port between the main process and the utility, set on both ends. Both
 * keep the default 1 MiB window, so the 256 KiB threshold is reached well before a sender runs out
 * of credit; a sender can still wait up to `delayMs` for credit in edge cases. Evidence so far is
 * throughput, not tail latency: bench/transport on Node workers (32 MiB transfers +12 to 17%, 4 KiB
 * requests at concurrency 8 +7%) and a short Electron main↔utility probe (concurrency 8 +13%,
 * 32 MiB download +14%), where lone 4 KiB requests showed a higher p99. Re-check with the real-app
 * mixed fetch benchmark (`scripts/bench.ts`, README "Real-app benchmark") before treating it as
 * settled. The library default stays off, since there it cannot know the peer's window.
 *
 * Dev and test builds can turn it off on both ends for that benchmark (`DESKTOP_PORT_ACK_COALESCE`,
 * ~/debug-env.ts); the main process resolves it once and the utility follows.
 */
export const PORT_ACK_COALESCE: AckCoalesceOptions = { bytes: 256 * 1024, delayMs: 1 };
