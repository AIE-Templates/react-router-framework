import { cancelRelease } from "./backlog.ts";
import { runFetchClient } from "./fetch.ts";
import { expect, isPeerCloseReport, isRunConfig, parseJson } from "./guards.ts";
import { setupLink } from "./links/index.ts";
import { type ProcessMetrics, startMetrics } from "./metrics.ts";
import { sourcePackages } from "./packages.ts";
import { rates, runProducer, type StreamResult } from "./producer.ts";
import type { RunResult } from "./result.ts";
import { sleep } from "./scheduler.ts";
import { type StatsTree, statsWindow } from "./stats.ts";

// One run in a fresh process: `node src/run-one.ts <config json> <repeat>`; prints `RESULT {json}`.
const config = expect(parseJson(process.argv[2] ?? "{}"), isRunConfig, "run config");
const repeat = Number(process.argv[3] ?? 0);

async function main(): Promise<RunResult> {
  const packages = sourcePackages();
  const startedAt = new Date().toISOString();
  const link = await setupLink(config.link, config);
  const base = {
    link: config.link,
    case: config.caseSpec.name,
    variant: config.variant,
    suite: config.suite,
    seed: config.seed,
    repeat,
    params: {
      windowBytes: config.windowBytes,
      warmupMs: config.warmupMs,
      measureMs: config.measureMs,
      sendBudget: config.sendBudget,
      wsReceiver: config.wsReceiver,
    },
    options: config.options,
    packages,
    startedAt,
  };
  // Sender metrics cover the measure window only, the same one as goodput and the counters.
  let window: { stop(): ProcessMetrics } | undefined;
  let sender: ProcessMetrics | undefined;
  const senderMetrics = () => {
    if (!sender) throw new Error("the measure window never ended");
    return sender;
  };
  try {
    if (config.caseSpec.fetch) {
      if (!link.port) throw new Error("the link has no port for port-fetch");
      const fetch = await runFetchClient(link.port, config, {
        measureStart: () => (window = startMetrics()),
        measureEnd: () => (sender = window?.stop()),
      });
      const stats = collect({ client: fetch.transport, server: fetch.peer.transport });
      return { ...base, fetch, sender: senderMetrics(), stats };
    }
    if (!link.endpoint) throw new Error("the link has no stream endpoint");
    const endpoint = link.endpoint;
    const local = statsWindow(() => collect({ sender: endpoint.stats?.(), ...link.stats?.() }));
    let localStats: StatsTree | undefined;
    const stream = await runProducer(endpoint, config, {
      measureStart: () => {
        local.start();
        window = startMetrics();
      },
      measureEnd: () => {
        sender = window?.stop();
        localStats = local.stop();
      },
    });
    if ((stream.cancel || stream.closed) && link.peerClose) await addPeerClose(stream, link.peerClose);
    const stats = collect({ ...localStats, peer: stream.peer.transport });
    return { ...base, stream, sender: senderMetrics(), stats };
  } finally {
    await link.teardown();
  }
}

/**
 * After a cancel or a close the endpoint cannot carry the peer's stats: wait (up to 15 s: a peer
 * still working through its backlog sees the close late) for its close report over the link's side
 * channel, take its window stats when it has one, and derive what happened to the backlog.
 */
async function addPeerClose(stream: StreamResult, pending: Promise<unknown>): Promise<void> {
  const report = await Promise.race([pending, sleep(15_000).then(() => undefined)]);
  if (report === undefined) return;
  const peerClose = expect(report, isPeerCloseReport, "peer close report");
  stream.peerClose = peerClose;
  const window = peerClose.stats.window;
  if (window) {
    stream.peer = peerClose.stats;
    stream.goodput = rates(window.bytes, window.messages, window.ms);
  }
  const { cancel } = stream;
  if (cancel?.atEpochMs !== undefined && cancel.consumedBeforeCancel !== undefined) {
    stream.release = cancelRelease(
      {
        atEpochMs: cancel.atEpochMs,
        framesBeforeCancel: cancel.framesBeforeCancel,
        consumedBeforeCancel: cancel.consumedBeforeCancel,
      },
      peerClose,
      config.caseSpec.ackEvery === 1,
    );
  }
}

/** Drops absent components; `undefined` when none has counters (raw variant, old package build). */
function collect(parts: Record<string, StatsTree | number | undefined>): Record<string, StatsTree> | undefined {
  const out: Record<string, StatsTree> = {};
  for (const [key, value] of Object.entries(parts)) {
    if (value !== undefined && typeof value === "object") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

main()
  .then((result) => {
    process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
    process.exit(0);
  })
  .catch((err: unknown) => {
    process.stdout.write(
      `RESULT ${JSON.stringify({ error: err instanceof Error ? (err.stack ?? err.message) : String(err) })}\n`,
    );
    process.exit(1);
  });
