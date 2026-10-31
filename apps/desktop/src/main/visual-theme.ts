import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isVisualThemePreference, type VisualThemePreference } from "@repo/shared";

import { nodeFs, renameWithRetry, writeDurably, type AtomicFileFs } from "./atomic-file.ts";
import type { Logger } from "./log.ts";

export const VISUAL_THEME_FILE = "visual-theme.json";
export interface VisualThemeStore {
  current(): VisualThemePreference;
  save(preference: VisualThemePreference): boolean;
}
export function createVisualThemeStore(
  userData: string,
  { log, fs = nodeFs }: { log: Logger; fs?: AtomicFileFs },
): VisualThemeStore {
  const file = join(userData, VISUAL_THEME_FILE);
  let preference: VisualThemePreference = "auto";
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      "version" in value &&
      value.version === 1 &&
      "colorScheme" in value &&
      isVisualThemePreference(value.colorScheme)
    )
      preference = value.colorScheme;
  } catch {
    /* Missing or invalid mirrors use the system theme. */
  }
  let persisted = false;
  return {
    current: () => preference,
    save(next) {
      if (persisted && next === preference) return true;
      const temp = `${file}.tmp`;
      try {
        writeDurably(fs, temp, `${JSON.stringify({ version: 1, colorScheme: next })}\n`);
        renameWithRetry(fs, temp, file);
        preference = next;
        persisted = true;
        return true;
      } catch {
        try {
          fs.rmSync(temp, { force: true });
        } catch {
          /* A later write replaces the temporary file. */
        }
        log.warn({}, "visual theme mirror persistence failed");
        return false;
      }
    },
  };
}
