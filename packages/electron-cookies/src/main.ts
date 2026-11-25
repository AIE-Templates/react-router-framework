import { randomUUID } from "node:crypto";

import type { Session } from "electron";

import { parseCookieDate, parseSetCookie } from "./parse.ts";
import { createScriptCookies, type ScriptCookies } from "./script-cookies.ts";
import { OMIT_COOKIES_HEADER } from "./shared.ts";
import {
  abandonOn,
  CookieStoreTimeoutError,
  type CookieLogger,
  type CookieStore,
  type CookieWrite,
  STORE_TIMEOUT_MS,
  observeStore,
  orderCookies,
  serializeCookies,
  toCookieWrite,
  storeDeadline,
  writeCookie,
  type WriteResult,
} from "./store.ts";

export {
  CookieStoreTimeoutError,
  flushForQuit,
  STORE_TIMEOUT_MS,
  type CookieLogger,
  type CookieStore,
} from "./store.ts";

export interface CookieRequest {
  path: string;
  initiatorOrigin?: string;
  headers: Pick<Headers, "has">;
}

export interface CookieJar {
  readonly script: ScriptCookies;
  cookieHeader(request: CookieRequest, signal?: AbortSignal): Promise<string | undefined>;
  storeResponseCookies(headers: Headers, request: CookieRequest): Promise<void>;
}

export interface CookieJarOptions<S extends { cookies: CookieStore } = Session> {
  scheme: string;
  host: string;
  origin: string;
  storageOrigin: string;
  upstreamHost: string;
  store: CookieStore;
  fromPartition(partition: string): S;
  installPermissionPolicy(session: S): void;
  log: CookieLogger;
  timeoutMs?: number;
}

export const MAX_SET_COOKIES_PER_RESPONSE = 50;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export { installCookieIpc, type CookieIpcOptions, SYNC_STORE_TIMEOUT_MS, SYNC_STORE_PROBE_TIMEOUT_MS } from "./ipc.ts";

export function createCookieJar<S extends { cookies: CookieStore }>(options: CookieJarOptions<S>): CookieJar {
  const { storageOrigin, log, timeoutMs = STORE_TIMEOUT_MS } = options;
  const store = observeStore(options.store);
  const storageHost = new URL(storageOrigin).hostname;
  const slowWrites = new Map<string, Promise<WriteResult>>();
  let probeStore: CookieStore | undefined;

  function accepts(request: CookieRequest): boolean {
    // Chromium supplies the initiator. Node's URL.origin is "null" for a custom scheme.
    return (
      (request.initiatorOrigin === undefined || request.initiatorOrigin === options.origin) &&
      !request.headers.has(OMIT_COOKIES_HEADER)
    );
  }

  function probe(): CookieStore {
    if (!probeStore) {
      const session = options.fromPartition("cookie-probe-" + randomUUID());
      options.installPermissionPolicy(session);
      probeStore = session.cookies;
    }
    return probeStore;
  }

  async function downgrade(details: CookieWrite, deadline: AbortSignal): Promise<WriteResult> {
    const retry = await writeCookie(store, details, deadline);
    if (retry.status !== "rejected") return retry;

    let isolated: CookieStore;
    try {
      isolated = probe();
    } catch (err) {
      log.warn({ err }, "creating cookie probe session failed");
      return { status: "rejected", reason: err };
    }
    const valid = await writeCookie(isolated, details, deadline);
    if (valid.status !== "stored") return valid;

    // Submit both operations before yielding so other reads cannot land between them.
    const clear = writeCookie(store, { ...details, httpOnly: true, value: "1", expirationDate: 1 }, deadline);
    if (details.expirationDate !== undefined && details.expirationDate * 1000 <= Date.now()) return clear;
    const [removed, replacement] = await Promise.all([clear, writeCookie(store, details, deadline)]);
    if (replacement.status === "stored") return replacement;
    log.warn({ name: details.name, result: replacement.status }, "cookie replacement after HttpOnly removal failed");
    // A confirmed removal followed by a confirmed rejection is a committed deletion.
    if (replacement.status === "rejected" && removed.status === "stored") return removed;
    return replacement;
  }

  function retryInOrder(key: string, details: CookieWrite, deadline: AbortSignal): Promise<WriteResult> {
    const previous = slowWrites.get(key);
    const run = () => downgrade(details, deadline);
    const current = previous ? previous.then(run) : run();
    slowWrites.set(key, current);
    const done = current.finally(() => {
      if (slowWrites.get(key) === current) slowWrites.delete(key);
    });
    // A queued response has its own deadline. Its expired turn will submit no writes.
    return abandonOn(done, deadline).catch((err: unknown) => {
      if (deadline.aborted) return { status: "unknown" };
      throw err;
    });
  }

  async function storeBatch(headers: Headers, values: string[], path: string, deadline: AbortSignal): Promise<void> {
    const now = Date.now();
    const date = parseCookieDate(headers.get("date") ?? "");
    const serverDate = Number.isFinite(date) ? date : undefined;
    const writes: CookieWrite[] = [];
    if (values.length > MAX_SET_COOKIES_PER_RESPONSE) {
      log.debug({ count: values.length }, "too many Set-Cookie headers; extra ones ignored");
    }
    for (const value of values.slice(0, MAX_SET_COOKIES_PER_RESPONSE)) {
      let header: string;
      try {
        header = decoder.decode(Buffer.from(value, "latin1"));
      } catch {
        log.warn({}, "ignoring Set-Cookie with invalid UTF-8");
        continue;
      }
      const parsed = parseSetCookie(header, { requestPath: path, now, serverDate });
      if (!parsed.ok) {
        log.debug({ reason: parsed.reason }, "Set-Cookie ignored");
        continue;
      }
      writes.push(toCookieWrite(parsed.cookie, storageOrigin, storageHost, options.upstreamHost));
    }

    const outcomes = await Promise.all(writes.map((details) => writeCookie(store, details, deadline)));
    const groups = new Map<string, { details: CookieWrite; result: WriteResult }[]>();
    for (const [index, details] of writes.entries()) {
      const key = JSON.stringify([details.name, details.domain, details.path]);
      const group = groups.get(key) ?? [];
      group.push({ details, result: outcomes[index] });
      groups.set(key, group);
    }
    // Later accepted writes (including deletions) supersede earlier rejected writes of the same identity.
    const changed = await Promise.all(
      Array.from(groups, async ([key, group]) => {
        for (const { details, result } of group.toReversed()) {
          let outcome = result;
          if (outcome.status === "rejected" && !details.httpOnly && !deadline.aborted) {
            outcome = await retryInOrder(key, details, deadline);
          }
          if (outcome.status === "stored") return true;
          if (outcome.status === "unknown") break;
          log.debug({ name: details.name }, "cookie rejected by the store");
        }
        return false;
      }),
    );
    if (!deadline.aborted && changed.includes(true)) {
      await abandonOn(store.flushStore(), deadline);
    }
  }

  return {
    script: createScriptCookies(store, options.origin, options.host, storageOrigin, storageHost),
    async cookieHeader(request, signal) {
      if (!accepts(request)) return undefined;
      const deadline = storeDeadline(timeoutMs);
      try {
        const waiting = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
        const cookies = await abandonOn(store.get({ url: storageOrigin + request.path }), waiting);
        return cookies.length
          ? Buffer.from(serializeCookies(orderCookies(cookies)), "utf8").toString("latin1")
          : undefined;
      } catch (err) {
        if (signal?.aborted) return undefined;
        if (err instanceof CookieStoreTimeoutError) throw err;
        log.warn({ err }, "reading cookies failed");
        return undefined;
      } finally {
        deadline.clear();
      }
    },
    async storeResponseCookies(headers, request) {
      if (!accepts(request)) return;
      const values = headers.getSetCookie();
      if (!values.length) return;
      const deadline = storeDeadline(timeoutMs);
      try {
        await storeBatch(headers, values, request.path, deadline.signal);
      } catch (err) {
        if (!deadline.signal.aborted) log.warn({ err }, "storing response cookies failed");
      } finally {
        if (deadline.signal.aborted)
          log.warn({ timeoutMs }, "storing cookies timed out; response cookie state is unknown");
        deadline.clear();
      }
    },
  };
}

export { installCookieWorkerIpc, type CookieWorkerIpcOptions } from "./main/sw/electron.ts";
export type { WakeRecord, WakeStorage } from "./main/sw/contracts.ts";
