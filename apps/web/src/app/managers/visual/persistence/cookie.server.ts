import { visualCookie } from "../../../config/visual-cookie";
import { readVisualCookie } from "./cookie";
/** Pure per-request parsing. Missing build-time cookies never become a user seed. */
export function readVisualRequestSeed(request: Request) {
  if (!visualCookie.enabled) return undefined;
  const result = readVisualCookie(request.headers.get("cookie"));
  return result.kind === "valid" ? result.preferences : undefined;
}
