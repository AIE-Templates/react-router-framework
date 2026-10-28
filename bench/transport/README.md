# @repo/bench-transport

Repeatable benchmarks for port-fetch and channel over same-thread ports, worker ports, loopback WebSocket and relay. Each run records environment, revision, runtime versions, CPU/OS, seed and parameters. Raw and package variants use matching workloads. Benchmark runs are separate from workspace unit tests; benchmark harness unit tests validate scheduling, histograms, consumers, counters and lifecycle behavior.

```bash
pnpm bench:transport --suite smoke
pnpm bench:transport --suite full --link worker --case terminal --variant package --repeat 5 --out results/terminal-worker.json
pnpm --filter @repo/bench-transport compare results/baseline.json results/candidate.json
```

Use CLI help for the available package options, WebSocket receiver type, credit/ACK batching and case filters. Disable DevTools, logging and profiling during formal measurement; profile in a separate run. WebSocket compression is disabled and links are plaintext loopback; TLS, real networks and compression are different experiments.

## Model

Fetch cases are closed-loop capacity/idle-RTT measurements at fixed concurrency. Stream cases use an open-loop intended schedule with seeded data and a cooperative send budget. They include terminal, bulk and slow-consumer/recovery/cancellation workloads. Same-thread results establish fixed-cost reference points, not a ranking of network transports.

Warmup, measurement and drain are distinct windows. Latency is measured from intended time and from actual send time to acknowledgement using one clock; RTT/2 is not measured one-way latency. Late frames and generatorLimited indicate a producer constrained by backpressure or event-loop work; interpret latency as at least that large. Outstanding tracked frames/RPCs at cancellation or unexpected closure become censored lower-bound samples instead of disappearing from percentiles.

## Metrics

Goodput measures actual consumption in the peer's measurement window, not send return, socket callbacks or drain completion. Slow-consumer cases use peer close reports when appropriate. Compare repeated medians by link/case/variant; interleave baseline/candidate runs. Five-second smoke runs can have too few samples for meaningful p99.

Backlog distinguishes in-flight bytes from end-to-end schedule lag. Use sender-clock clearedAfterMs for recovery, rather than only peer queue-empty timing. Slow consumers can constrain goodput to their rate while intended-time latency grows; inspect RPC latency and backlog alongside throughput.

CPU includes process and thread deltas divided by each measurement wall time. Worker peers share process counters; compare threadCpu for thread cost. Memory samples rss, heapUsed, external and arrayBuffers every 250ms; external includes arrayBuffers, so do not add them. Worker rss is process-wide. Baseline includes warmup allocations. GC and event-loop delay are measured with perf_hooks.

Cancellation measures local completion using one clock, not remote cleanup. Unexpected closure stops producers immediately and records code/reason/error/phase/time rather than waiting on closed barriers. The peer releases held work and reports consumption, drops and memory through a side channel after delayed forced GC. run-one waits at most 15 seconds for that report; cancellation release metrics distinguish never-delivered and peer-dropped work. Cross-process close timing uses wall clocks and is labeled accordingly.

Node Request/AbortSignal lifetimes and V8 heap policy can create large temporary old-generation growth without proving a leak. Compare equal durations/rates and inspect GC plus post-collection retained memory. Heap limits do not bound rss. Never compare files with different measurement, scheduling, flow-control or counter semantics as though they measured the same workload; regenerate a baseline after changing those definitions.

## Implementation

`cli.ts` creates the run matrix and fresh processes; `run-one.ts` executes one run. `workload.ts`, `scheduler.ts` and `histogram.ts` define seeded loads, intended/send/completion timing and distributions. `metrics.ts` samples resource use. `consumer.ts`, `producer.ts`, `peer.ts` and `backlog.ts` implement bounded consumption and reports. `fetch.ts` covers request/response workloads; `endpoint.ts` normalizes raw and package transports; `links/` contains concrete links. `stats.ts` reduces counters by window and `compare.ts` compares saved results.
