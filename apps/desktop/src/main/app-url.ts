/** Stable storage identity. Changing this origin requires migrating browser storage. */
export const APP_SCHEME = "app";
export const APP_HOST = "app";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** Compare scheme and host: Node serializes this custom scheme's origin as "null". */
export function isAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST;
  } catch {
    return false;
  }
}
