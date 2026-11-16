import type { Session, WebContents } from "electron";

import type { Logger } from "./log.ts";
import { isAppUrl, isExternalUrl } from "./window.ts";

interface PermissionSource {
  isMainFrame: boolean;
  requestingUrl?: string;
  externalURL?: string;
}

/** Only the app document receives the small set of permissions needed by the shell. */
export function isPermitted(permission: string, source: PermissionSource): boolean {
  if (!source.isMainFrame || !source.requestingUrl || !isAppUrl(source.requestingUrl)) return false;
  if (permission === "openExternal") return !!source.externalURL && isExternalUrl(source.externalURL);
  return permission === "clipboard-sanitized-write" || permission === "fullscreen";
}

type PermissionSession = Pick<
  Session,
  "setPermissionRequestHandler" | "setPermissionCheckHandler" | "setDevicePermissionHandler"
>;

function hasAppDocument(contents: WebContents | null): boolean {
  return !!contents && !contents.isDestroyed() && isAppUrl(contents.mainFrame.url);
}

/** Install before any page loads: Electron otherwise grants permission requests by default. */
export function installPermissionPolicy(session: PermissionSession, log: Logger): void {
  const report = (permission: string, allowed: boolean) => {
    if (!allowed) log.warn({ permission }, "denied renderer permission");
    return allowed;
  };

  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(report(permission, hasAppDocument(contents) && isPermitted(permission, details)));
  });
  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    report(permission, hasAppDocument(contents) && isAppUrl(requestingOrigin) && isPermitted(permission, details)),
  );
  // Device checks have no frame identity. Device selection and persisted grants are not enabled.
  session.setDevicePermissionHandler(({ deviceType }) => report(deviceType, false));
}
