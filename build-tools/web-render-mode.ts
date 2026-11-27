import { readFileSync } from "node:fs";
import { join } from "node:path";

/** React Router writes its resolved mode beside the Web build, outside the public client tree. */
export const WEB_RENDER_MODE_FILE = "render-mode";

export function webBuildSsr(directory: string): boolean {
  const mode = readFileSync(join(directory, WEB_RENDER_MODE_FILE), "utf8").trim();
  if (mode === "ssr") return true;
  if (mode === "spa") return false;
  throw new Error("Invalid Web render mode: rebuild the Web app");
}
