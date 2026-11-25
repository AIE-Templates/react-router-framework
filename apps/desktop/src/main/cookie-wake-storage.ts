import { readFileSync, writeFileSync } from "node:fs";
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
    (!("pinned" in value) || typeof value.pinned === "boolean") &&
    (!("name" in value) || typeof value.name === "string") &&
    (!("url" in value) || (typeof value.url === "string" && isAppUrl(value.url) && value.url.startsWith(value.scope)))
  );
}

export function cookieWakeStorage(directory: string, log: CookieLogger): WakeStorage {
  const file = join(directory, "cookie-wake-index.json");
  let persistenceDisabled = false;
  return {
    read() {
      if (persistenceDisabled) return [];
      let data: Buffer;
      try {
        data = readFileSync(file);
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
        persistenceDisabled = true;
        log.warn({ err }, "Could not read cookie wake index; using in-memory wake hints for this launch");
        return [];
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString("utf8"));
      } catch {
        // Recover an unreadable root below, retaining the original bytes for the backup.
      }
      let records: WakeRecord[] = [];
      if (Array.isArray(parsed)) {
        records = parsed.filter(isWakeRecord);
        if (records.length === parsed.length) return records;
        log.warn({ invalidRecords: parsed.length - records.length }, "Invalid cookie wake index records");
      } else {
        log.warn({}, "Unreadable cookie wake index");
      }
      try {
        writeFileSync(file + ".corrupt", data);
      } catch (err) {
        log.warn({ err }, "Could not back up damaged cookie wake index");
      }
      return records;
    },
    write: (records) => (persistenceDisabled ? Promise.resolve() : writeAtomicFile(file, JSON.stringify(records))),
  };
}
