import { APP_ID, storageKey } from "@repo/shared";

export { APP_ID };
export const STORAGE_PREFIX = storageKey("");
export const STORAGE_KEYS = { visualPreferences: storageKey("visual-preferences") } as const;
