import type { MiddlewareHandler } from "hono";
import type { RequestIdVariables } from "hono/request-id";
import { pino, type Logger } from "pino";

declare module "hono" {
  interface ContextVariableMap extends RequestIdVariables {
    /** The request's logger, carrying its `requestId`. Set by `requestLogger()`. */
    logger: Logger;
  }
}

/**
 * The log level from `LOG_LEVEL`, or the default for `NODE_ENV`: `debug` in development, `silent` in
 * tests and `warn` otherwise, production included. An empty value uses the default; an unknown one
 * throws at startup.
 */
export function resolveLogLevel(value: string | undefined, nodeEnv: string | undefined): string {
  if (!value) return nodeEnv === "development" ? "debug" : nodeEnv === "test" ? "silent" : "warn";
  const levels = [...Object.keys(pino.levels.values), "silent"];
  if (!levels.includes(value)) throw new Error(`Invalid LOG_LEVEL "${value}": expected one of ${levels.join(", ")}`);
  return value;
}

const { NODE_ENV } = process.env;

const options = {
  level: resolveLogLevel(process.env.LOG_LEVEL, NODE_ENV),
  formatters: { level: (label: string) => ({ level: label }) },
  timestamp: pino.stdTimeFunctions.isoTime,
};

/**
 * The app's logger: JSON lines for log platforms, pretty-printed when `NODE_ENV` is `development`
 * (what `react-router dev` and `pnpm dev:server` set). An unset `NODE_ENV` counts as production, so a
 * host that mounts the app without setting it (an API gateway, Electron) gets production logging.
 * See `resolveLogLevel()` for the level.
 */
export const logger: Logger = NODE_ENV === "development" ? pino(options, await prettyStream()) : pino(options);

/**
 * pino-pretty as a stream, not a transport: transports run in a worker thread, which silently drops
 * output under Vite's module runner. It is a dev dependency, so it is imported only here and only in
 * development; if it is not installed (a production install run with NODE_ENV=development), the
 * logger falls back to JSON lines. Any other failure to load it is an error worth seeing.
 */
async function prettyStream(): Promise<pino.DestinationStream | undefined> {
  try {
    return (await import("pino-pretty")).default({ ignore: "pid,hostname" });
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ERR_MODULE_NOT_FOUND") return undefined;
    throw err;
  }
}

/**
 * Gives each request a child logger with its `requestId` (as `c.var.logger`) and logs one line when
 * it completes: `info` up to 4xx and for requests the client aborted, `error` with the error for 5xx.
 * The query string is left out because it can carry tokens, e.g. OAuth codes or signed links.
 * Register after `requestId()`.
 */
export function requestLogger(base: Logger = logger): MiddlewareHandler {
  return async (c, next) => {
    const log = base.child({ requestId: c.var.requestId });
    c.set("logger", log);
    const start = performance.now();
    await next();
    const fields = {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - start),
    };
    // A client disconnecting mid-request often turns into a 500; that is not a server error.
    if (c.req.raw.signal.aborted) log.info(fields, "request aborted");
    else if (c.res.status >= 500) log.error({ ...fields, err: c.error }, "request failed");
    else log.info(fields, "request completed");
  };
}

/**
 * Wraps `response`'s body so that an error while streaming it is logged with the request ID and then
 * ends the connection through `abort`, so the client sees an incomplete response. @hono/node-server
 * would otherwise print the error unstructured, without the request ID.
 */
export function logStreamErrors(response: Response, abort: () => void, base: Logger = logger): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  // Set when the client goes away: a read still pending then settles after this stream is closed.
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (cancelled) return;
        base.error({ err, requestId: response.headers.get("x-request-id") ?? undefined }, "response stream failed");
        abort();
        controller.close();
        return;
      }
      if (cancelled) return;
      if (chunk.done) controller.close();
      else controller.enqueue(chunk.value);
    },
    cancel: (reason) => {
      cancelled = true;
      return reader.cancel(reason);
    },
  });
  return new Response(body, response);
}
