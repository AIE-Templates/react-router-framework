/** Presence on an application protocol request suppresses cookie lookup and storage. */
export const OMIT_COOKIES_HEADER = "x-desktop-omit-cookies";

/** Names shared by the main process and its sandboxed preloads. */
export function cookieIpcChannels(prefix: string) {
  return {
    get: prefix + ":cookie:get",
    set: prefix + ":cookie:set",
    getAll: prefix + ":cookie-store:get-all",
    storeSet: prefix + ":cookie-store:set",
    register: prefix + ":cookie-store:register",
    acquire: prefix + ":cookie-worker:acquire",
    complete: prefix + ":cookie-worker:complete",
    deliver: prefix + ":cookie-worker:deliver",
    finish: prefix + ":cookie-worker:finish",
    started: prefix + ":cookie-worker:started",
    ack: prefix + ":cookie-worker:ack",
    nack: prefix + ":cookie-worker:nack",
    changed: prefix + ":cookie-store:changed",
  } as const;
}

export interface CookieIpcError {
  name: string;
  message: string;
}

/** Public domain and millisecond timestamp, never the storage hostname or seconds. */
export interface WindowCookie {
  name: string;
  value: string;
  domain: string | null;
  path: string;
  expires: number | null;
  sameSite: "strict" | "lax" | "none";
  secure: boolean;
  partitioned: false;
}

type DeletedCookie = Omit<WindowCookie, "value" | "expires" | "sameSite"> & Partial<Pick<WindowCookie, "sameSite">>;

export interface CookiePush {
  documentId: string;
  changed: WindowCookie[];
  deleted: DeletedCookie[];
}

export type CookieReply<T> = { ok: true; value: T } | { ok: false; error: CookieIpcError };

export type WorkerCookieItem = DeletedCookie & Partial<Pick<WindowCookie, "value" | "expires">>;

export interface WorkerCookieEvent {
  eventId: string;
  changed: readonly WorkerCookieItem[];
  deleted: readonly WorkerCookieItem[];
}

export interface Subscription {
  readonly name?: string;
  readonly url?: string;
}

export type SubscriptionOperation =
  | { kind: "subscribe" | "unsubscribe"; subscriptions: readonly Subscription[] }
  | { kind: "unregister" };
