import type { PortStats } from "@repo/port-fetch";

/** Where the benchmark's own endpoints live; nothing in the web app uses this prefix. */
export const BENCH_PREFIX = "/__bench/";

/** The largest body `/__bench/bytes` serves, so a stray request cannot make the utility stream forever. */
export const MAX_BENCH_BYTES = 1024 * 1024 * 1024;
const DEFAULT_CHUNK = 64 * 1024;

/** What `/__bench/proc` reports: the utility's own clock, CPU, memory and port-fetch server counters. */
export interface BenchProc {
  uptimeMs: number;
  cpu: NodeJS.CpuUsage;
  memory: NodeJS.MemoryUsage;
  stats?: PortStats;
}

/**
 * The benchmark's endpoints, in front of the web app (`DESKTOP_BENCH=1` only; the utility entry
 * installs them only then). They answer before Hono, so the bulk cases measure the transport, not
 * the app's middleware; the small API cases use the real `/api/health` instead.
 *
 * - `GET /__bench/bytes?n=<bytes>&chunk=<bytes>`: `n` bytes streamed in `chunk`-sized pieces
 *   (default 64 KiB, what a file stream yields), each a fresh copy, as a real producer would allocate.
 * - `POST /__bench/upload`: reads the whole body, answers `{ bytes }`.
 * - `GET /__bench/proc`: `BenchProc`.
 */
export function withBenchRoutes(
  fetch: (request: Request) => Response | Promise<Response>,
  serverStats: () => PortStats | undefined,
): (request: Request) => Response | Promise<Response> {
  const source = new Uint8Array(1024 * 1024);
  for (let i = 0; i < source.length; i++) source[i] = (i * 2654435761) >>> 24;
  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(BENCH_PREFIX)) return fetch(request);
    const route = url.pathname.slice(BENCH_PREFIX.length);
    if (route === "bytes" && request.method === "GET") {
      const total = boundedInt(url.searchParams.get("n"), 0, MAX_BENCH_BYTES);
      const chunk = boundedInt(url.searchParams.get("chunk") ?? String(DEFAULT_CHUNK), 1, source.length);
      if (total === undefined || chunk === undefined) return new Response("bad n or chunk", { status: 400 });
      return new Response(byteStream(source, total, chunk), {
        headers: { "content-type": "application/octet-stream", "content-length": String(total) },
      });
    }
    if (route === "upload" && request.method === "POST") {
      let bytes = 0;
      if (request.body) for await (const piece of request.body) bytes += piece.byteLength;
      return Response.json({ bytes });
    }
    if (route === "proc" && request.method === "GET") {
      const proc: BenchProc = {
        uptimeMs: process.uptime() * 1000,
        cpu: process.cpuUsage(),
        memory: process.memoryUsage(),
        stats: serverStats(),
      };
      return Response.json(proc);
    }
    return new Response("Not Found", { status: 404 });
  };
}

function byteStream(source: Uint8Array, total: number, chunk: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent >= total) {
          controller.close();
          return;
        }
        const length = Math.min(chunk, total - sent);
        controller.enqueue(source.slice(0, length));
        sent += length;
      },
    },
    { highWaterMark: 0 },
  );
}

function boundedInt(value: string | null, min: number, max: number): number | undefined {
  if (value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
}
