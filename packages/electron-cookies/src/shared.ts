/** Presence on an application protocol request suppresses cookie lookup and storage. */
export const OMIT_COOKIES_HEADER = "x-desktop-omit-cookies";

/** Names shared by the main process and its sandboxed preloads. */
export function cookieIpcChannels(prefix: string) {
  return {
    get: prefix + ":cookie:get",
    set: prefix + ":cookie:set",
    getAll: prefix + ":cookie-store:get-all",
    storeSet: prefix + ":cookie-store:set",
    changed: prefix + ":cookie-store:changed",
  } as const;
}

export interface CookieIpcError {
  name: string;
  message: string;
}
