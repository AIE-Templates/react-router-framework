/** Change once when creating an application; keep stable across releases. */
export const APP_ID = "framework-app";

/** Preserve the existing visual-cookie spelling while making an app ID cookie-safe. */
export function cookieSafe(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function storageKey(name: string): string {
  return `${APP_ID}:${name}`;
}

export function cookieName(name: string): string {
  return `${cookieSafe(APP_ID)}_${name}`;
}
