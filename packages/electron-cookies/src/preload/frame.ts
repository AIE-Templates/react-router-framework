import type { CookieFrame, CookieInstallation } from "./types.ts";

// Each preload has its own module instance. Same-origin frames share the symbol registry.
const creationUrlKey = Symbol.for("@repo/electron-cookies/preload/creation-url");

interface IsolatedWindow {
  origin: string;
  location: Pick<Location, "protocol" | "href">;
  parent: IsolatedWindow;
  [creationUrlKey]?: string | null;
}

/** Runs once at preload entry, before page code can change the document URL. */
export function prepareCookieFrame(appOrigin: string, frame: IsolatedWindow, isMainFrame: boolean): CookieInstallation {
  const {
    origin,
    location: { protocol, href },
  } = frame;
  const installation = selectCookieInstallation(appOrigin, {
    origin,
    protocol,
    href,
    isMainFrame,
    get parentCreationUrl() {
      try {
        return frame.parent[creationUrlKey];
      } catch {
        // A navigating parent may no longer be accessible through its WindowProxy.
        return null;
      }
    },
  });
  frame[creationUrlKey] = installation.creationUrl;
  return installation;
}

/** Call at preload entry and retain the returned snapshot on this isolated window. */
export function selectCookieInstallation(appOrigin: string, frame: CookieFrame): CookieInstallation {
  // Electron supplies the effective origin, including sandbox and inherited origins.
  if (frame.origin === "null" || frame.origin !== appOrigin) {
    return { cookieApi: false, fetch: false, creationUrl: null };
  }
  if (frame.protocol === "blob:") {
    return { cookieApi: false, fetch: true, creationUrl: null };
  }
  if (frame.protocol === "about:") {
    const isSrcdoc = new URL(frame.href).pathname === "srcdoc";
    const inherited = !frame.isMainFrame && isSrcdoc ? frame.parentCreationUrl : null;
    if (inherited) {
      return { cookieApi: true, fetch: true, creationUrl: inherited };
    }
    // about:blank does not run a preload. Keep its unsupported inheritance explicit.
    return { cookieApi: false, fetch: isSrcdoc, creationUrl: null };
  }
  return { cookieApi: true, fetch: true, creationUrl: frame.href };
}
