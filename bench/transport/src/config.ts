import type { PortChannelOptions, RelayOptions, WebSocketChannelOptions } from "@repo/channel";
import type { PortFetchOptions } from "@repo/port-fetch";

import type { SendBudget } from "./scheduler.ts";
import type { CaseSpec } from "./workload.ts";

export type LinkName = "same-thread" | "worker" | "ws" | "relay";
export type Variant = "raw" | "package";
export type Suite = "smoke" | "full";
/** What the `ws` server's channel sees of its socket: `ws` itself (pausable) or a standard WebSocket (cannot pause). */
export type WsReceiver = "pausable" | "standard";

/** What both sides of a run need to know; serializable, so workers and child processes get a copy. */
export interface RunConfig {
  link: LinkName;
  variant: Variant;
  suite: Suite;
  seed: number;
  caseSpec: CaseSpec;
  /** Flow-control window for the package variant and the raw credit window alike. */
  windowBytes: number;
  warmupMs: number;
  measureMs: number;
  /**
   * How much a send loop (every timetable: stream, RPC, reverse, warmup; raw and package alike) may
   * send without an event-loop turn before it yields one (`--send-budget bytes,ms`).
   */
  sendBudget: SendBudget;
  /** Package options from `--options`, passed to both ends; `{}` runs the package defaults. */
  options: BenchOptions;
  /**
   * `--ws-receiver`: `standard` hides `pause()`/`resume()` of the `ws` server's socket from the
   * peer's channel (package variant, `ws` and `relay` links), so it behaves as a browser's standard
   * WebSocket would. Absent: `pausable`.
   */
  wsReceiver?: WsReceiver;
}

/**
 * What `--options` passes to the package variant's constructors, on both ends of the link.
 * `channel` goes to every `channelFromPort()` and `channelFromWebSocket()` the run creates (sender,
 * peer and both relay sides); each implementation ignores the keys it does not know, so
 * `ackCoalesce` only acts on port channels and `sendWithCallback` only on WebSocket channels.
 * `portFetch` goes to `createPortFetch()` and `servePort()` alike, `relay` to `relay()`. Keys given
 * here override the harness's own (`windowBytes` from `--window`, `lowWaterBytes` at half of it).
 * Plain JSON, so it reaches workers and child processes as is.
 */
export interface BenchOptions {
  channel?: PortChannelOptions & WebSocketChannelOptions;
  portFetch?: Omit<PortFetchOptions, "timeoutMs" | "headersTimeoutMs" | "idleTimeoutMs">;
  relay?: RelayOptions;
}

export const SUITES: Record<Suite, { warmupMs: number; measureMs: number }> = {
  smoke: { warmupMs: 2_000, measureMs: 5_000 },
  full: { warmupMs: 10_000, measureMs: 60_000 },
};

export const LINKS: readonly LinkName[] = ["same-thread", "worker", "ws", "relay"];

/** Which (link, variant) pairs a case can run on. */
export function supports(config: Pick<RunConfig, "link" | "variant" | "caseSpec">): string | undefined {
  const { link, variant, caseSpec } = config;
  if (caseSpec.fetch) {
    if (link === "ws" || link === "relay") return "port-fetch needs a message port; the ws and relay links have none";
    if (variant === "raw") return "port-fetch cases have no raw variant (the raw stream cases are the raw baseline)";
    return undefined;
  }
  if (link === "relay" && variant === "raw") return "the relay link exists only for the package variant";
  return undefined;
}
