import type { JarCookie } from "./parse.ts";

export interface CookieLogger {
  debug(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
}

export interface CookieStore {
  get(filter: { url: string }): Promise<{ name: string; value: string; path?: string }[]>;
  set(details: CookieWrite): Promise<void>;
  flushStore(): Promise<void>;
}

export interface CookieWrite extends JarCookie {
  url: string;
}

export type WriteResult = { status: "stored" } | { status: "rejected"; reason: unknown } | { status: "unknown" };

/** Submit synchronously. A timeout bounds the caller's wait, not the underlying store operation. */
export async function writeCookie(
  store: CookieStore,
  details: CookieWrite,
  deadline: AbortSignal,
): Promise<WriteResult> {
  if (deadline.aborted) return { status: "unknown" };
  try {
    const { url, name, value, path, domain, secure, httpOnly, sameSite, expirationDate } = details;
    await abandonOn(
      store.set({
        url,
        name,
        value,
        path,
        secure,
        httpOnly,
        sameSite,
        ...(domain === undefined ? {} : { domain }),
        ...(expirationDate === undefined ? {} : { expirationDate }),
      }),
      deadline,
    );
    return { status: "stored" };
  } catch (reason) {
    return deadline.aborted ? { status: "unknown" } : { status: "rejected", reason };
  }
}

/**
 * How long one request waits for the store: for its cookie lookup, and again for all the writes and
 * the flush of its response. A call that is in flight when the network service dies never settles
 * (measured on Electron 45, macOS: neither resolved nor rejected); calls made afterwards wait for
 * the restarted service, about 60 ms, and normal ones take well under a millisecond.
 */
export const STORE_TIMEOUT_MS = 5_000;

/** The store did not answer a cookie lookup within `timeoutMs`. */
export class CookieStoreTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`cookie store did not answer within ${timeoutMs} ms`);
    this.name = "CookieStoreTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Settles like `operation`, or rejects with the signal's reason once `signal` aborts. The operation
 * is abandoned, not cancelled: the store has no cancellation.
 */
export function abandonOn<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** A signal that aborts with `CookieStoreTimeoutError` after `timeoutMs`, until `clear()`. */
export function storeDeadline(timeoutMs: number): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new CookieStoreTimeoutError(timeoutMs)), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** How long quitting waits for the cookie store to reach the disk. */
export const QUIT_FLUSH_TIMEOUT_MS = 2_000;

/**
 * `flushStore()` for quitting, bounded: a store that never answers must not keep the app from
 * quitting. Resolves when the flush settles or after `timeoutMs`, whichever comes first; never rejects.
 */
export async function flushForQuit(
  store: Pick<CookieStore, "flushStore">,
  log: CookieLogger,
  timeoutMs = QUIT_FLUSH_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const flushed = store.flushStore().then(
    () => "flushed" as const,
    (err: unknown) => {
      log.warn({ err }, "flushing cookies before quit failed");
      return "failed" as const;
    },
  );
  try {
    if ((await Promise.race([flushed, timeout])) === "timeout") {
      log.warn({ timeoutMs }, "flushing cookies before quit timed out; quitting anyway");
    }
  } finally {
    clearTimeout(timer);
  }
}
