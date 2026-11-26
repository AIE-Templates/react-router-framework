import { readFileSync } from "node:fs";
import { join } from "node:path";

import { visualRecordKernel as records, type VisualMirrorSnapshot, type VisualRecord } from "@repo/shared";

import { nodeFs, renameWithRetry, writeDurably, type AtomicFileFs } from "./atomic-file.ts";
import type { Logger } from "./log.ts";

const fileSystem = { ...nodeFs, readFileSync: (file: string) => readFileSync(file, "utf8") };
export type VisualMirror = ReturnType<typeof createVisualMirror>;

export function createVisualMirror(
  userData: string,
  {
    log,
    fs = fileSystem,
  }: {
    log: Pick<Logger, "warn">;
    fs?: AtomicFileFs & { readFileSync(file: string): string };
  },
) {
  const file = join(userData, "visual.json");
  const temp = file + ".tmp";
  let record: VisualRecord | undefined;
  try {
    record = records.decode(fs.readFileSync(file)).record;
  } catch {
    // First launch or unavailable storage.
  }
  let raw = record ? records.encode(record) : null;
  let pending = false;
  const listeners = new Set<() => void>();
  function persist(value: string) {
    try {
      writeDurably(fs, temp, value);
      renameWithRetry(fs, temp, file);
      pending = false;
    } catch {
      pending = true;
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // A subsequent attempt replaces the temporary file.
      }
      log.warn({}, "visual mirror write failed");
    }
  }
  function retryPending() {
    if (pending && raw !== null) persist(raw);
  }
  return {
    read: (): VisualMirrorSnapshot => ({ record: raw, pending }),
    colorScheme: () => records.effective(record).colorScheme,
    retryPending,
    push(input: unknown): "ok" | "failed" {
      const next = typeof input === "string" ? records.decode(input).record : undefined;
      if (!next) {
        retryPending();
        log.warn({}, "invalid visual mirror record");
        return "failed";
      }
      const order = record ? records.compare(next, record) : 1;
      if (order <= 0) {
        retryPending();
        return pending && order === 0 ? "failed" : "ok";
      }
      const encoded = records.encode(next);
      const previousColor = records.effective(record).colorScheme;
      persist(encoded);
      raw = encoded;
      record = next;
      if (records.effective(next).colorScheme !== previousColor) {
        for (const notify of listeners) {
          try {
            notify();
          } catch {
            log.warn({}, "applying native visual appearance failed");
          }
        }
      }
      return pending ? "failed" : "ok";
    },
    onColorSchemeChange(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
