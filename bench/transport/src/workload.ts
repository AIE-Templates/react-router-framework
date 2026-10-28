/**
 * Deterministic workloads. Everything a case sends is derived from a seed, so two runs of the same
 * case compare the same bytes; the corpus is generated and touched before timing starts, so neither
 * random numbers nor lazy allocation count as transport cost.
 */

/** xorshift32: tiny, seeded, good enough for incompressible-looking bytes and jitter. */
export function xorshift32(seed: number): () => number {
  let x = seed >>> 0 || 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

/** `bytes` of pseudo-random data (incompressible) or a repeating ANSI/text pattern (compressible). */
export function corpus(bytes: number, seed: number, kind: "random" | "text" = "random"): Uint8Array {
  const out = new Uint8Array(bytes);
  if (kind === "text") {
    const pattern = new TextEncoder().encode(
      "\x1b[32m$\x1b[0m ls -la /home/user/project \u7ec8\u7aef\u8f93\u51fa emoji 🚀 line\r\n" +
        "drwxr-xr-x  12 user staff   384 Oct 27 10:00 .\r\n",
    );
    for (let i = 0; i < bytes; i++) out[i] = pattern[i % pattern.length] ?? 0;
  } else {
    const next = xorshift32(seed);
    let i = 0;
    for (; i + 4 <= bytes; i += 4) {
      const v = next();
      out[i] = v & 0xff;
      out[i + 1] = (v >>> 8) & 0xff;
      out[i + 2] = (v >>> 16) & 0xff;
      out[i + 3] = v >>> 24;
    }
    for (; i < bytes; i++) out[i] = next() & 0xff;
  }
  // Touch every page so the first send does not pay for lazy allocation.
  let sum = 0;
  for (let i = 0; i < bytes; i += 4096) sum += out[i] ?? 0;
  if (sum === -1) throw new Error("unreachable");
  return out;
}

/** A stream of frames at a fixed rate, or as fast as backpressure allows (`ratePerSec` 0). */
export interface StreamSpec {
  frameBytes: number;
  /** Frames per second on an absolute timetable; `0` means "as fast as allowed" up to `totalBytes`. */
  ratePerSec: number;
  /** Stop after this many bytes (bulk cases); `0` means until the measure window ends. */
  totalBytes: number;
  /** Bytes kind: random is incompressible, text is terminal-like. */
  kind: "random" | "text";
}

/** Request/response traffic the sender issues on a timetable, answered by the peer with `responseBytes`. */
export interface RpcSpec {
  ratePerSec: number;
  requestBytes: number;
  responseBytes: number;
}

export interface CaseSpec {
  name: string;
  description: string;
  /** Data the sender streams to the peer. */
  stream?: StreamSpec;
  /** Data the peer streams back to the sender (terminal input, the "reverse" direction). */
  reverse?: StreamSpec;
  /** Request/response traffic from the sender. */
  rpc?: RpcSpec;
  /** The peer pauses consumption for `pauseMs` every `everyMs` (slow consumer). */
  slowConsumer?: { everyMs: number; pauseMs: number };
  /** The peer consumes at a fixed byte rate, FIFO, slower than the producer (see `ConsumerSpec`). */
  consumer?: ConsumerSpec;
  /**
   * Every this many data frames (by sequence number) is acknowledged by the peer and tracked for
   * latency; defaults to `SAMPLE_EVERY` (16). `1` gives the sender an exact count of what the peer
   * consumed (the backlog and recovery measurements need it).
   */
  ackEvery?: number;
  /** Close the sender's channel after this many data frames (cancel propagation). */
  cancelAtFrame?: number;
  /**
   * Close the sender's channel when the measure window ends, with whatever backlog is in flight,
   * instead of draining it; the peer reports what it consumed, dropped and still held.
   */
  cancelAtEnd?: boolean;
  /** Request/response cases run through @repo/port-fetch instead of a stream. */
  fetch?: FetchSpec;
}

/**
 * A consumer slower than its producer for good: one shared byte budget, strict FIFO (see
 * `RateConsumer`). The producer runs on its timetable and stops at each window's deadline instead
 * of catching up afterwards (`stopAtDeadline`), so a backlog it can never send does not stretch the
 * run.
 */
export interface ConsumerSpec {
  /** Payload bytes per second the consumer takes. */
  bytesPerSec: number;
  /**
   * The consumer recovers (consumes without limit) from this fraction of the peer's measure window
   * on; absent: slow for the whole run, warmup included.
   */
  recoverAtFraction?: number;
}

export interface FetchSpec {
  kind: "json" | "stream" | "download" | "upload" | "cancel";
  /** Response or request body size. */
  bytes: number;
  /** Chunk size the server streams with (download/stream/cancel) or the client uploads with. */
  chunkBytes: number;
  /** Closed-loop concurrency (outstanding requests). */
  concurrency: number;
  /** For `cancel`: cancel the response body after this many bytes. */
  cancelAfterBytes?: number;
}

const KiB = 1024;
const MiB = 1024 * KiB;

/** Every case of this version. Rates are per second; sizes in bytes. */
export const CASES: readonly CaseSpec[] = [
  {
    name: "small-256b",
    description: "Fixed per-message cost: 256 B frames at 10k/s",
    stream: { frameBytes: 256, ratePerSec: 10_000, totalBytes: 0, kind: "random" },
  },
  {
    name: "small-4k",
    description: "Fixed per-message cost: 4 KiB frames at 10k/s",
    stream: { frameBytes: 4 * KiB, ratePerSec: 10_000, totalBytes: 0, kind: "random" },
  },
  {
    name: "terminal",
    description: "Terminal steady state: 1 KiB output at 2000/s, 64 B input at 100/s the other way",
    stream: { frameBytes: KiB, ratePerSec: 2_000, totalBytes: 0, kind: "text" },
    reverse: { frameBytes: 64, ratePerSec: 100, totalBytes: 0, kind: "text" },
  },
  {
    name: "bulk-64k",
    description: "Bulk: 64 KiB chunks as fast as backpressure allows, for the whole warmup and measure window",
    stream: { frameBytes: 64 * KiB, ratePerSec: 0, totalBytes: 0, kind: "random" },
  },
  {
    name: "bulk-1m",
    description: "Bulk: 1 MiB chunks as fast as backpressure allows, for the whole warmup and measure window",
    stream: { frameBytes: MiB, ratePerSec: 0, totalBytes: 0, kind: "random" },
  },
  {
    name: "mixed-rpc-bulk",
    description: "RPC 256 B → 1 KiB at 100/s each way over a bulk background of 64 KiB frames at 400/s (~25 MiB/s)",
    stream: { frameBytes: 64 * KiB, ratePerSec: 400, totalBytes: 0, kind: "random" },
    rpc: { ratePerSec: 100, requestBytes: 256, responseBytes: KiB },
    reverse: { frameBytes: 256, ratePerSec: 100, totalBytes: 0, kind: "text" },
  },
  {
    name: "slow-consumer",
    description: "1 KiB at 2000/s into a consumer that pauses 20 ms every 100 ms; cancel at frame 8000",
    stream: { frameBytes: KiB, ratePerSec: 2_000, totalBytes: 0, kind: "text" },
    slowConsumer: { everyMs: 100, pauseMs: 20 },
    cancelAtFrame: 8_000,
  },
  {
    name: "sustained-slow",
    description:
      "64 KiB at 128/s (8 MiB/s) into a FIFO consumer that takes 2 MiB/s for the whole run, RPC 256 B → 1 KiB at 100/s; cancel at the end of the window",
    stream: { frameBytes: 64 * KiB, ratePerSec: 128, totalBytes: 0, kind: "random" },
    rpc: { ratePerSec: 100, requestBytes: 256, responseBytes: KiB },
    consumer: { bytesPerSec: 2 * MiB },
    ackEvery: 1,
    cancelAtEnd: true,
  },
  {
    name: "slow-recover",
    description:
      "64 KiB at 128/s (8 MiB/s) into a FIFO consumer at 2 MiB/s for the first half of the window, unlimited after, RPC 256 B → 1 KiB at 100/s",
    stream: { frameBytes: 64 * KiB, ratePerSec: 128, totalBytes: 0, kind: "random" },
    rpc: { ratePerSec: 100, requestBytes: 256, responseBytes: KiB },
    consumer: { bytesPerSec: 2 * MiB, recoverAtFraction: 0.5 },
    ackEvery: 1,
  },
  {
    name: "fetch-json-4k",
    description: "port-fetch: 4 KiB JSON responses, closed loop, concurrency 1",
    fetch: { kind: "json", bytes: 4 * KiB, chunkBytes: 0, concurrency: 1 },
  },
  {
    name: "fetch-json-4k-c8",
    description: "port-fetch: 4 KiB JSON responses, closed loop, concurrency 8",
    fetch: { kind: "json", bytes: 4 * KiB, chunkBytes: 0, concurrency: 8 },
  },
  {
    name: "fetch-stream-256k",
    description: "port-fetch: 256 KiB streamed response (SSR-like, 16 KiB chunks), concurrency 1",
    fetch: { kind: "stream", bytes: 256 * KiB, chunkBytes: 16 * KiB, concurrency: 1 },
  },
  {
    name: "fetch-download-32m",
    description: "port-fetch: 32 MiB download in 64 KiB chunks",
    fetch: { kind: "download", bytes: 32 * MiB, chunkBytes: 64 * KiB, concurrency: 1 },
  },
  {
    name: "fetch-upload-32m",
    description: "port-fetch: 32 MiB upload in 64 KiB chunks",
    fetch: { kind: "upload", bytes: 32 * MiB, chunkBytes: 64 * KiB, concurrency: 1 },
  },
  {
    name: "fetch-download-32m-1m",
    description: "port-fetch: 32 MiB download in 1 MiB source chunks (what maxChunkBytes splits)",
    fetch: { kind: "download", bytes: 32 * MiB, chunkBytes: MiB, concurrency: 1 },
  },
  {
    name: "fetch-upload-32m-1m",
    description: "port-fetch: 32 MiB upload in 1 MiB source chunks (what maxChunkBytes splits)",
    fetch: { kind: "upload", bytes: 32 * MiB, chunkBytes: MiB, concurrency: 1 },
  },
  {
    name: "fetch-cancel",
    description: "port-fetch: 32 MiB download cancelled after 4 MiB; time until the client body settles",
    fetch: { kind: "cancel", bytes: 32 * MiB, chunkBytes: 64 * KiB, concurrency: 1, cancelAfterBytes: 4 * MiB },
  },
];

export function findCase(name: string): CaseSpec {
  const spec = CASES.find((c) => c.name === name);
  if (!spec) throw new Error(`Unknown case "${name}". Known: ${CASES.map((c) => c.name).join(", ")}`);
  return spec;
}
