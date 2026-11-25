import type { CookiePush, CookieReply, WindowCookie } from "../shared.ts";

export type { CookiePush, CookieReply, WindowCookie } from "../shared.ts";

/** One snapshot per document, retained in the isolated world for nested srcdoc frames. */
export type CookieInstallation =
  | { cookieApi: true; fetch: boolean; creationUrl: string }
  | { cookieApi: false; fetch: boolean; creationUrl: null };

export interface CookieFrame {
  origin: string;
  protocol: string;
  href: string;
  isMainFrame: boolean;
  parentCreationUrl?: string | null;
}

export type CookieShimOptions = CookieInstallation & {
  appOrigin: string;
  appHost: string;
  markerHeader: string;
  documentId: string;
};

export interface CookieShimBridge {
  options: CookieShimOptions;
  getCookie(creationUrl: string): unknown;
  setCookie(creationUrl: string, text: string): void;
  getAll(creationUrl: string, name?: string): Promise<CookieReply<WindowCookie[]>>;
  set(creationUrl: string, cookie: WindowCookie): Promise<CookieReply<void>>;
  /** Attach the isolated-world receiver before sending the registration IPC. */
  registerChanges(creationUrl: string, documentId: string, receive: (push: CookiePush) => void): void;
}
