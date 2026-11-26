import { visualCookie } from "~/config/visual-cookie";

/** Included verbatim in the inline script. Malformed escaping is an invalid value, not a missing cookie. */
export function readVisualCookie(header: string, name: string): string | null {
  const prefix = name + "=";
  const entry = header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  if (!entry) return null;
  try {
    return decodeURIComponent(entry.slice(prefix.length));
  } catch {
    return "";
  }
}

export function writeVisualCookie(host: Window, raw: string, name = visualCookie.name) {
  const secure = host.location.protocol === "https:" ? "; Secure" : "";
  host.document.cookie = `${name}=${encodeURIComponent(raw)}; Path=/; SameSite=Lax; Max-Age=${visualCookie.maxAge}${secure}`;
}
