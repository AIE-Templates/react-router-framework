// Types only (`c.var.logger`); the runtime pieces come in through `StreamHelpers`.

import type { Context } from "hono";
import { Hono } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";

/** Where the smoke's own endpoints live; nothing in the web app uses this prefix. */
export const SMOKE_PREFIX = "/__smoke";

/** Bounds for `/__smoke/sse`, so a stray request cannot make the utility stream for long. */
export const MAX_SMOKE_EVENTS = 100;
export const MAX_SMOKE_INTERVAL_MS = 1000;
/** How many streams `/__smoke/sse-status` remembers. */
const REMEMBERED_STREAMS = 8;

/** What `/__smoke/sse-status?id=` reports about one `/__smoke/sse` request, from the utility's side. */
export interface SmokeStreamStatus {
  /** Events written so far. */
  events: number;
  /** Whether the request's `signal` has aborted. */
  aborted: boolean;
  /** Milliseconds from the stream's start to the abort, by the utility's clock. */
  abortedAfterMs?: number;
  /** Whether the stream wrote its last event and closed by itself. */
  completed: boolean;
}

/** The two @repo/server helpers AGENTS.md requires around Hono's streaming helpers. */
export interface StreamHelpers {
  rethrowNonErrors: <Args extends unknown[]>(
    callback: (...args: Args) => Promise<void>,
  ) => (...args: Args) => Promise<void>;
  logStreamFailure: (c: Context) => (err: Error) => Promise<void>;
}

/**
 * The smoke's endpoints (`DESKTOP_SMOKE=1` only; the utility entry mounts them only then), mounted
 * at `SMOKE_PREFIX` inside the web app's chain, so they get request IDs, logging and error handling
 * like any route. The helpers come from the web app's server build rather than a second copy of
 * @repo/server in the utility bundle.
 *
 * - `GET /__smoke/sse?id=<id>&count=<n>&interval=<ms>`: `n` server-sent events, one every `ms`, then
 *   an `end` event; stops early when the request's `signal` aborts.
 * - `GET /__smoke/sse-status?id=<id>`: `SmokeStreamStatus` of that stream (404 if unknown), so the
 *   smoke can see whether a cancel in the renderer reached `request.signal` in the utility.
 */
export function smokeRoutes({ rethrowNonErrors, logStreamFailure }: StreamHelpers) {
  const streams = new Map<string, SmokeStreamStatus>();
  return new Hono()
    .get("/sse", (c) => {
      const id = c.req.query("id") ?? "";
      const count = boundedInt(c.req.query("count"), 1, MAX_SMOKE_EVENTS);
      const interval = boundedInt(c.req.query("interval"), 0, MAX_SMOKE_INTERVAL_MS);
      if (!/^[\w-]{1,64}$/.test(id) || count === undefined || interval === undefined)
        return c.json({ error: "bad id, count or interval" }, 400);
      const status: SmokeStreamStatus = { events: 0, aborted: false, completed: false };
      streams.delete(id);
      streams.set(id, status);
      while (streams.size > REMEMBERED_STREAMS) streams.delete(streams.keys().next().value!);
      const started = performance.now();
      const signal = c.req.raw.signal;
      const log = c.var.logger;
      const onAbort = () => {
        status.aborted = true;
        status.abortedAfterMs = Math.round(performance.now() - started);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      return streamSSE(
        c,
        rethrowNonErrors(async (stream: SSEStreamingApi) => {
          for (let i = 0; i < count && !signal.aborted; i++) {
            if (i > 0) await stream.sleep(interval);
            if (signal.aborted) break;
            await stream.writeSSE({
              id: String(i),
              data: JSON.stringify({ i, atMs: Math.round(performance.now() - started) }),
            });
            status.events = i + 1;
          }
          if (!signal.aborted) {
            await stream.writeSSE({ event: "end", data: String(status.events) });
            status.completed = true;
          }
          log.info({ id, ...status }, "smoke sse finished");
        }),
        logStreamFailure(c),
      );
    })
    .get("/sse-status", (c) => {
      const status = streams.get(c.req.query("id") ?? "");
      return status ? c.json(status) : c.json({ error: "unknown stream" }, 404);
    });
}

function boundedInt(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
}
