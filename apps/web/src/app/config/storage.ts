/** Change this once when creating an application; keep it stable across releases. */
export const APP_ID = "framework-app";
export const STORAGE_PREFIX = `${APP_ID}:`;
export const STORAGE_KEYS = { visualPreferences: `${STORAGE_PREFIX}visual-preferences` } as const;
