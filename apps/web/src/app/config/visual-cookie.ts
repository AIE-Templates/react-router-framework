import { APP_ID } from "./storage";
/** Build-time opt-in; desktop documents always disable the Web cookie adapter. */
export const visualCookie = {
  enabled: import.meta.env.VITE_VISUAL_COOKIE === "true",
  name: `${APP_ID.replace(/[^a-zA-Z0-9_-]/g, "_")}_visual`,
  maxAge: 365 * 24 * 60 * 60,
};
