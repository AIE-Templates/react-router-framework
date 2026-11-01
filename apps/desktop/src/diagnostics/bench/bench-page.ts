/**
 * The renderer side of the benchmark (`DESKTOP_BENCH=1`): closed-loop `fetch` workers in the page,
 * timed on the renderer's clock. `runPageCase` is serialized with `toString()` and run through
 * `executeJavaScript`, so it must stay self-contained: no imports, no references to anything outside
 * its own body (types are erased).
 */

/** One unit of work a page worker repeats. */
export type PageOp =
  /** `GET /api/health` through the whole Hono stack, JSON parsed. */
  | { kind: "health" }
  /** `GET /__bench/bytes?n=…`, the body read chunk by chunk. */
  | { kind: "bytes"; bytes: number }
  /** `GET /` as a document (`Accept: text/html`): React Router SSR, the body read as text. */
  | { kind: "document" }
  /** Every hashed asset of the page at once, as a page load fetches them; done when all are read. */
  | { kind: "assets"; urls: string[] }
  /** `POST /__bench/upload` with a body of `bytes` bytes. */
  | { kind: "upload"; bytes: number };

export interface PageCaseSpec {
  durationMs: number;
  /** Whether latencies are kept (false for warmup). */
  record: boolean;
  op: PageOp;
  concurrency: number;
  /** Load running alongside for as long as the foreground does (latency behind bulk). */
  background?: { op: PageOp; concurrency: number };
}

export interface LatencySummary {
  count: number;
  meanMs: number;
  p50Ms: number;
  p90Ms: number;
  p99Ms: number;
  p999Ms: number;
  maxMs: number;
}

export interface LoopResult {
  ops: number;
  bytes: number;
  errors: number;
  /** The first error, for the log. */
  firstError?: string;
  /** From the first worker's start to the last worker's end, renderer clock. */
  wallMs: number;
  latency?: LatencySummary;
}

export interface PageCaseResult {
  foreground: LoopResult;
  background?: LoopResult;
}

// The helpers stay inside runPageCase on purpose: it is serialized on its own.
// oxlint-disable unicorn/consistent-function-scoping
export async function runPageCase(spec: PageCaseSpec): Promise<PageCaseResult> {
  const uploads = new Map<number, Uint8Array<ArrayBuffer>>();
  const uploadBody = (bytes: number): Uint8Array<ArrayBuffer> => {
    let body = uploads.get(bytes);
    if (!body) {
      body = new Uint8Array(bytes);
      for (let i = 0; i < bytes; i++) body[i] = (i * 31) & 0xff;
      uploads.set(bytes, body);
    }
    return body;
  };

  const drain = async (response: Response): Promise<number> => {
    if (!response.body) return 0;
    const reader = response.body.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return total;
      total += value.byteLength;
    }
  };

  const check = (response: Response, what: string): void => {
    if (!response.ok) throw new Error(`${what}: HTTP ${response.status}`);
  };

  const once = async (op: PageOp): Promise<number> => {
    switch (op.kind) {
      case "health": {
        const r = await fetch("/api/health", { cache: "no-store" });
        check(r, "health");
        const text = await r.text();
        JSON.parse(text);
        return text.length;
      }
      case "bytes": {
        const r = await fetch(`/__bench/bytes?n=${op.bytes}`, { cache: "no-store" });
        check(r, "bytes");
        const n = await drain(r);
        if (n !== op.bytes) throw new Error(`bytes: got ${n} of ${op.bytes}`);
        return n;
      }
      case "document": {
        const r = await fetch("/", { cache: "no-store", headers: { accept: "text/html" } });
        check(r, "document");
        return (await r.text()).length;
      }
      case "assets": {
        const sizes = await Promise.all(
          op.urls.map(async (url) => {
            const r = await fetch(url, { cache: "no-store" });
            check(r, url);
            return (await r.arrayBuffer()).byteLength;
          }),
        );
        return sizes.reduce((a, b) => a + b, 0);
      }
      case "upload": {
        const r = await fetch("/__bench/upload", { method: "POST", body: uploadBody(op.bytes), cache: "no-store" });
        check(r, "upload");
        const answer: unknown = await r.json();
        const bytes = typeof answer === "object" && answer !== null && "bytes" in answer ? answer.bytes : undefined;
        if (bytes !== op.bytes) throw new Error(`upload: server got ${String(bytes)} of ${op.bytes}`);
        return op.bytes;
      }
      default:
        throw new Error(`unknown op ${JSON.stringify(op)}`);
    }
  };

  const summarize = (unsorted: number[]): LatencySummary => {
    const samples = unsorted.toSorted((a, b) => a - b);
    const at = (q: number) =>
      samples.length === 0 ? 0 : samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
    const round = (ms: number) => Math.round(ms * 1000) / 1000;
    let sum = 0;
    for (const s of samples) sum += s;
    return {
      count: samples.length,
      meanMs: round(samples.length ? sum / samples.length : 0),
      p50Ms: round(at(0.5)),
      p90Ms: round(at(0.9)),
      p99Ms: round(at(0.99)),
      p999Ms: round(at(0.999)),
      maxMs: round(samples.length ? samples[samples.length - 1] : 0),
    };
  };

  /** `concurrency` workers repeating `op` until `shouldStop()`; each op timed from call to body read. */
  const loop = async (op: PageOp, concurrency: number, record: boolean, shouldStop: () => boolean) => {
    if (op.kind === "upload") uploadBody(op.bytes);
    const samples: number[] = [];
    const result: LoopResult = { ops: 0, bytes: 0, errors: 0, wallMs: 0 };
    const start = performance.now();
    const worker = async () => {
      while (!shouldStop()) {
        const t0 = performance.now();
        try {
          // Not `result.bytes += await once(op)`: that reads `bytes` before the await and loses the
          // other workers' updates.
          const bytes = await once(op);
          result.bytes += bytes;
          result.ops++;
          if (record) samples.push(performance.now() - t0);
        } catch (err) {
          result.errors++;
          result.firstError ??= err instanceof Error ? err.message : String(err);
          // A failing op must not spin: the run is reported as broken either way.
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    result.wallMs = performance.now() - start;
    if (record) result.latency = summarize(samples);
    return result;
  };

  const deadline = performance.now() + spec.durationMs;
  let foregroundDone = false;
  const background = spec.background
    ? loop(spec.background.op, spec.background.concurrency, spec.record, () => foregroundDone)
    : undefined;
  const foreground = await loop(spec.op, spec.concurrency, spec.record, () => performance.now() >= deadline);
  foregroundDone = true;
  return { foreground, background: background ? await background : undefined };
}
// oxlint-enable unicorn/consistent-function-scoping
