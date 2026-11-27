import { cookieName } from "./app-identity.ts";

export const visualCookie = { name: cookieName("visual"), maxAge: 365 * 24 * 60 * 60 };

export function serializeVisualCookie(raw: string, secure: boolean, name = visualCookie.name): string {
  return `${name}=${encodeURIComponent(raw)}; Path=/; SameSite=Lax; Max-Age=${visualCookie.maxAge}${secure ? "; Secure" : ""}`;
}
