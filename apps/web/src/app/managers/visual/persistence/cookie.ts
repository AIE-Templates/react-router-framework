import { visualCookie } from "../../../config/visual-cookie";
import { visualCodec } from "../bootstrap";
import type { VisualPreferences } from "../types";
export function readVisualCookie(header: string | null) {
  const entry = header
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${visualCookie.name}=`));
  if (!entry) return visualCodec.decode(null);
  try {
    return visualCodec.decode(decodeURIComponent(entry.slice(visualCookie.name.length + 1)));
  } catch {
    return { kind: "invalid" as const };
  }
}
export function writeVisualCookie(
  preferences: Readonly<VisualPreferences>,
  doc: Pick<Document, "cookie" | "location"> = document,
  reset = false,
) {
  const value = encodeURIComponent(JSON.stringify({ version: 1, preferences }));
  try {
    if (!reset && readVisualCookie(doc.cookie).kind === "unsupported-version") return "unsupported-version" as const;
    doc.cookie = `${visualCookie.name}=${value}; Path=/; SameSite=Lax; Max-Age=${visualCookie.maxAge}${doc.location.protocol === "https:" ? "; Secure" : ""}`;
    const result = readVisualCookie(doc.cookie);
    return result.kind === "valid" && JSON.stringify(result.preferences) === JSON.stringify(preferences)
      ? ("synced" as const)
      : ("failed" as const);
  } catch {
    return "failed" as const;
  }
}
