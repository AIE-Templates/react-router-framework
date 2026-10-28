import type { MessagePort as NodeMessagePort } from "node:worker_threads";

import { createPortFetch, fromNodePort, type PortFetch, servePort } from "@repo/port-fetch";

import type { RunConfig } from "./config.ts";
import { readStats } from "./endpoint.ts";
import { expect, isProcessMetrics, isRecord } from "./guards.ts";
import { Histogram, round } from "./histogram.ts";
import type { HistogramSummary } from "./histogram.ts";
import { type ProcessMetrics, startMetrics } from "./metrics.ts";
import type { MeasureHooks } from "./producer.ts";
import { type StatsTree, statsWindow, toStatsTree } from "./stats.ts";
import { corpus } from "./workload.ts";

/**
 * Request/response cases over @repo/port-fetch: the peer serves a small Hono-less handler
 * (`servePort`), the sender runs a closed loop of `concurrency` requests and measures time to
 * headers and time to completion on its own clock; goodput is body bytes fully read.
 */
export interface FetchResult {
  requests: { started: number; completed: number; failed: number };
  ttfbMs: HistogramSummary;
  completeMs: HistogramSummary;
  goodput: { bytes: number; bytesPerSec: number; requestsPerSec: number; measureMs: number };
  cancel?: { samples: number; cancelToSettledMs: HistogramSummary };
  peer: { metrics?: ProcessMetrics; transport?: StatsTree };
  /** The client's `stats()` over the measure window. */
  transport?: StatsTree;
}

/** The peer side: a fetch handler for every fetch case, plus `/__measure` and `/__stats`. */
export function servePeer(port: NodeMessagePort, config: RunConfig): { close(): void } {
  const { bytes, chunkBytes } = config.caseSpec.fetch ?? { bytes: 0, chunkBytes: 0 };
  const chunk = corpus(Math.max(1, chunkBytes || bytes), config.seed, "random");
  const json = JSON.stringify({ data: "x".repeat(Math.max(0, bytes - 12)) });
  let metrics = startMetrics();
  let metricsResult: ProcessMetrics | undefined;
  let transport: StatsTree | undefined;
  let server: { close(): void } | undefined;
  const counters = statsWindow(() => (server ? readStats(server) : undefined));
  server = servePort(
    fromNodePort(port),
    async (request) => {
      const url = new URL(request.url);
      switch (url.pathname) {
        case "/json":
          return new Response(json, { headers: { "content-type": "application/json" } });
        case "/stream":
        case "/download": {
          const total = Number(url.searchParams.get("bytes") ?? bytes);
          let sent = 0;
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (sent >= total) {
                  controller.close();
                  return;
                }
                const piece = chunk.subarray(0, Math.min(chunk.byteLength, total - sent));
                sent += piece.byteLength;
                controller.enqueue(piece);
              },
            }),
            { headers: { "content-type": "application/octet-stream" } },
          );
        }
        case "/upload": {
          let received = 0;
          if (request.body) {
            const reader = request.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              received += value.byteLength;
            }
          }
          return new Response(String(received));
        }
        case "/__measure":
          metrics.stop();
          metrics = startMetrics();
          counters.start();
          return new Response("ok");
        case "/__stats":
          metricsResult ??= metrics.stop();
          transport ??= counters.stop();
          return new Response(JSON.stringify({ metrics: metricsResult, transport }), {
            headers: { "content-type": "application/json" },
          });
        default:
          return new Response("not found", { status: 404 });
      }
    },
    { windowBytes: config.windowBytes, ...config.options.portFetch },
  );
  return server;
}

/**
 * The measure window is the closed loop's: from after `/__measure` to the completion of the last
 * request. `hooks` run at those two points (the sender's process metrics); the client's counters
 * use the same points, and the peer's window runs from its handling of `/__measure` to its handling
 * of `/__stats`, sent right after the loop.
 */
export async function runFetchClient(
  port: NodeMessagePort,
  config: RunConfig,
  hooks: MeasureHooks = {},
): Promise<FetchResult> {
  const spec = config.caseSpec.fetch;
  if (!spec) throw new Error(`case ${config.caseSpec.name} is not a fetch case`);
  const fetch: PortFetch = createPortFetch(fromNodePort(port), {
    windowBytes: config.windowBytes,
    ...config.options.portFetch,
  });
  const clientStats = statsWindow(() => readStats(fetch));
  const origin = "http://bench.local";
  const upload = spec.kind === "upload" ? corpus(spec.chunkBytes, config.seed, "random") : undefined;

  const one = async (
    record: boolean,
    ttfb: Histogram,
    complete: Histogram,
    cancelHist: Histogram,
    counters: FetchResult["requests"],
  ) => {
    const start = performance.now();
    counters.started++;
    try {
      let response: Response;
      if (spec.kind === "json") {
        response = await fetch(new Request(`${origin}/json`));
      } else if (spec.kind === "upload") {
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= spec.bytes) {
              controller.close();
              return;
            }
            sent += upload!.byteLength;
            controller.enqueue(upload!);
          },
        });
        response = await fetch(new Request(`${origin}/upload`, { method: "POST", body, duplex: "half" }));
      } else {
        const path = spec.kind === "stream" ? "/stream" : "/download";
        response = await fetch(new Request(`${origin}${path}?bytes=${spec.bytes}`));
      }
      if (record) ttfb.record(performance.now() - start);
      // For an upload the response only arrives once the peer has consumed the whole body, so the
      // bytes it carried are confirmed goodput; for the other kinds the body read below counts.
      let bytes = spec.kind === "upload" ? spec.bytes : 0;
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (spec.kind === "cancel" && spec.cancelAfterBytes && bytes >= spec.cancelAfterBytes) {
            const cancelAt = performance.now();
            await reader.cancel("benchmark cancel");
            if (record) cancelHist.record(performance.now() - cancelAt);
            break;
          }
        }
      }
      if (record) complete.record(performance.now() - start);
      counters.completed++;
      return bytes;
    } catch {
      counters.failed++;
      return 0;
    }
  };

  const loop = async (
    untilMs: number,
    record: boolean,
    ttfb: Histogram,
    complete: Histogram,
    cancelHist: Histogram,
    counters: FetchResult["requests"],
  ) => {
    let bytes = 0;
    const workers = Array.from({ length: spec.concurrency }, async () => {
      while (performance.now() < untilMs) {
        // Not `bytes += await one()`: that reads `bytes` before the await and loses the other workers' updates.
        const done = await one(record, ttfb, complete, cancelHist, counters);
        bytes += done;
      }
    });
    await Promise.all(workers);
    return bytes;
  };

  const scratch = { started: 0, completed: 0, failed: 0 };
  await loop(performance.now() + config.warmupMs, false, new Histogram(), new Histogram(), new Histogram(), scratch);
  await (await fetch(new Request(`${origin}/__measure`))).text();

  const ttfb = new Histogram();
  const complete = new Histogram();
  const cancelHist = new Histogram();
  const counters = { started: 0, completed: 0, failed: 0 };
  hooks.measureStart?.();
  clientStats.start();
  const measureStart = performance.now();
  const bytes = await loop(measureStart + config.measureMs, true, ttfb, complete, cancelHist, counters);
  const measureMs = performance.now() - measureStart;
  const transport = clientStats.stop();
  hooks.measureEnd?.();
  const peerStats = expect(await (await fetch(new Request(`${origin}/__stats`))).json(), isRecord, "peer stats");
  const peerMetrics = expect(peerStats.metrics, isProcessMetrics, "peer metrics");
  return {
    requests: counters,
    ttfbMs: ttfb.summary(),
    completeMs: complete.summary(),
    goodput: {
      bytes,
      bytesPerSec: round((bytes / measureMs) * 1000, 0),
      requestsPerSec: round((counters.completed / measureMs) * 1000, 2),
      measureMs: round(measureMs),
    },
    cancel: spec.kind === "cancel" ? { samples: cancelHist.count, cancelToSettledMs: cancelHist.summary() } : undefined,
    peer: { metrics: peerMetrics, transport: toStatsTree(peerStats.transport) },
    transport,
  };
}
