import { cookieName } from "@repo/shared";
/** Build-time opt-in; desktop documents always disable the Web cookie adapter. */
export const visualCookie = {
  enabled: import.meta.env.VITE_VISUAL_COOKIE === "true",
  name: cookieName("visual"),
  maxAge: 365 * 24 * 60 * 60,
};
