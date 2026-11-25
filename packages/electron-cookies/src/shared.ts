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

export interface CookiePush {
  documentId: string;
  changed: WindowCookie[];
  deleted: Omit<WindowCookie, "value" | "expires">[];
}

export type CookieReply<T> = { ok: true; value: T } | { ok: false; error: CookieIpcError };
