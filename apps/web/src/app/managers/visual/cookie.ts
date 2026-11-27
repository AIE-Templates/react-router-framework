import { serializeVisualCookie } from "@repo/shared";

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

export function writeVisualCookie(host: Window, raw: string, name?: string) {
  host.document.cookie = serializeVisualCookie(raw, host.location.protocol === "https:", name);
}
