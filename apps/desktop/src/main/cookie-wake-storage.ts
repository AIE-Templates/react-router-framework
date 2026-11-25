import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { CookieLogger, WakeRecord, WakeStorage } from "@repo/electron-cookies/main";

import { isAppUrl } from "./app-url.ts";
import { writeAtomicFile } from "./atomic-file.ts";

function isWakeRecord(value: unknown): value is WakeRecord {
  if (!value || typeof value !== "object") return false;
  return (
    "scope" in value &&
    typeof value.scope === "string" &&
    isAppUrl(value.scope) &&
    "since" in value &&
    typeof value.since === "number" &&
    Number.isFinite(value.since) &&
    "eligible" in value &&
    typeof value.eligible === "boolean" &&
    (!("name" in value) || typeof value.name === "string") &&
    (!("url" in value) || (typeof value.url === "string" && isAppUrl(value.url) && value.url.startsWith(value.scope)))
  );
}

export function cookieWakeStorage(directory: string, log: CookieLogger): WakeStorage {
  const file = join(directory, "cookie-wake-index.json");
  return {
    read() {
      let data: string;
      try {
        data = readFileSync(file, "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
      }
      try {
        const parsed: unknown = JSON.parse(data);
        if (Array.isArray(parsed)) {
          const records = parsed.filter(isWakeRecord);
          if (records.length !== parsed.length) log.warn({}, "Ignored invalid cookie wake index records");
          return records;
        }
      } catch {
        // A damaged index can be rebuilt by subsequent subscriptions.
      }
      log.warn({}, "Unreadable cookie wake index");
      return [];
    },
    write: (records) => writeAtomicFile(file, JSON.stringify(records)),
  };
}
