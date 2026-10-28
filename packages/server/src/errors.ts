import type { Context, MiddlewareHandler } from "hono";

/**
 * Rethrows non-Error values as Errors. Hono only hands Error instances to `onError` and rethrows
 * anything else past every middleware, skipping the 500 response and the request log. A common
 * source is an upstream `fetch(url, { signal: c.req.raw.signal })` in a BFF route: when the client
 * disconnects, @hono/node-server aborts that signal with a string reason, which fetch rejects with.
 */
export function wrapThrownValues(): MiddlewareHandler {
  return async (_c, next) => {
    try {
      await next();
    } catch (err) {
      throw toError(err);
    }
  };
}

/**
 * Wraps the callback of Hono's `stream()`, `streamText()` or `streamSSE()` so that non-Error
 * rejections reach their `onError`: those helpers pass only Error instances to it and print anything
 * else with console.error. Use it with `logStreamFailure(c)`:
 *
 * @example return streamText(c, rethrowNonErrors(async (stream) => { ... }), logStreamFailure(c));
 */
export function rethrowNonErrors<Args extends unknown[]>(
  callback: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args) => {
    try {
      await callback(...args);
    } catch (err) {
      throw toError(err);
    }
  };
}

/**
 * An `onError` for Hono's streaming helpers that logs with the request's logger, skipping errors
 * caused by the client disconnecting.
 */
export function logStreamFailure(c: Context): (err: Error) => Promise<void> {
  return async (err) => {
    if (!c.req.raw.signal.aborted) c.var.logger.error({ err }, "stream failed");
  };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value), { cause: value });
}
