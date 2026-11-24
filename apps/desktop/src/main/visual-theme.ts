import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isVisualThemePreference, type VisualThemePreference, type VisualThemeSnapshot } from "@repo/shared";

import { nodeFs, renameWithRetry, writeDurably, type AtomicFileFs } from "./atomic-file.ts";
import type { Logger } from "./log.ts";

export const VISUAL_THEME_FILE = "visual-theme.json";
export interface VisualThemeStore {
  current(): VisualThemeSnapshot;
  subscribe(listener: (snapshot: VisualThemeSnapshot) => void): () => void;
  save(preference: VisualThemePreference): boolean;
}
export function createVisualThemeStore(
  userData: string,
  { log, fs = nodeFs }: { log: Logger; fs?: AtomicFileFs },
): VisualThemeStore {
  const file = join(userData, VISUAL_THEME_FILE);
  let preference: VisualThemePreference = "auto";
  let persisted = false;
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      "version" in value &&
      value.version === 1 &&
      "colorScheme" in value &&
      isVisualThemePreference(value.colorScheme)
    ) {
      preference = value.colorScheme;
      persisted = true;
    }
  } catch {
    /* Missing or invalid records use the system theme. */
  }
  let snapshot: VisualThemeSnapshot = Object.freeze({ revision: 0, preference });
  const listeners = new Set<(snapshot: VisualThemeSnapshot) => void>();
  return {
    current: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    save(next) {
      if (persisted && next === snapshot.preference) return true;
      const temp = `${file}.tmp`;
      try {
        writeDurably(fs, temp, `${JSON.stringify({ version: 1, colorScheme: next })}\n`);
        renameWithRetry(fs, temp, file);
      } catch {
        try {
          fs.rmSync(temp, { force: true });
        } catch {
          /* A later write replaces the temporary file. */
        }
        log.warn({}, "visual theme persistence failed");
        return false;
      }
      persisted = true;
      if (next !== snapshot.preference) {
        snapshot = Object.freeze({ preference: next, revision: snapshot.revision + 1 });
        for (const notify of listeners) notify(snapshot);
      }
      return true;
    },
  };
}
