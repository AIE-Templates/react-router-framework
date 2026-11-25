import type { Cookie } from "electron";

import type { JarCookie } from "./parse.ts";

export interface CookieLogger {
  debug(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
}

export interface CookieStore {
  get(filter: { url: string; httpOnly?: boolean }): Promise<Cookie[]>;
  set(details: CookieWrite): Promise<void>;
  flushStore(): Promise<void>;
}

/** A success on any entry point means synchronous callers can leave probe mode.
 * Count only the real session's operations, never writes in the validation session.
 */
export function observeStore(store: CookieStore) {
  let successes = 0;
  function succeeded<T>(value: T): T {
    successes++;
    return value;
  }
  return {
    get successes() {
      return successes;
    },
    get: (filter: Parameters<CookieStore["get"]>[0]) => store.get(filter).then(succeeded),
    set: (details: CookieWrite) => store.set(details).then(succeeded),
    flushStore: () => store.flushStore().then(succeeded),
  };
}

export interface CookieWrite extends JarCookie {
  url: string;
}

/** Map an accepted public Domain to the private store and preserve deletion identity. */
export function toCookieWrite(
  cookie: JarCookie,
  storageOrigin: string,
  storageHost: string,
  publicHost: string,
): CookieWrite {
  const details: CookieWrite = { ...cookie, url: storageOrigin + (cookie.defaultPathRequest ?? cookie.path) };
  if (details.domain === publicHost.toLowerCase()) details.domain = storageHost;
  return details;
}

/** Chromium's path order, retaining the store's creation order within equal paths. */
export function orderCookies(cookies: Cookie[]): Cookie[] {
  return cookies.toSorted((a, b) => (b.path ?? "/").length - (a.path ?? "/").length);
}

export function serializeCookies(ordered: Cookie[]): string {
  return ordered.map(({ name, value }) => (name === "" ? value : name + "=" + value)).join("; ");
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
        path: details.defaultPathRequest === undefined ? path : "",
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
export function storeDeadline(timeoutMs: number, startedAt?: number): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  const remaining = startedAt === undefined ? timeoutMs : Math.ceil(timeoutMs - (performance.now() - startedAt));
  const abort = () => controller.abort(new CookieStoreTimeoutError(timeoutMs));
  const timer = remaining > 0 ? setTimeout(abort, remaining) : undefined;
  if (remaining <= 0) abort();
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
