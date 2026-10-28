import type { Logger } from "pino";
import { createContext } from "react-router";

/**
 * The request's logger for `loader`/`action`, read with `context.get(loggerContext)`. It carries
 * the request's `requestId`, which the BFF calls it makes share. Server-side only.
 */
export const loggerContext = createContext<Logger>();

/**
 * Logs `promise` if it rejects and returns it unchanged, for deferred (streamed) loader data, whose
 * rejections React Router does not pass to `handleError`. `<Await>` still receives the rejection.
 * Pass the request's `signal` to skip rejections caused by the user leaving, as `handleError` does.
 *
 * @example return { reviews: logRejection(getReviews(), { log: context.get(loggerContext), signal: request.signal }) };
 */
export function logRejection<T>(
  promise: Promise<T>,
  { log, signal, message = "deferred data failed" }: { log: Logger; signal?: AbortSignal; message?: string },
): Promise<T> {
  void promise.catch((err: unknown) => {
    if (!signal?.aborted) log.error({ err }, message);
  });
  return promise;
}
