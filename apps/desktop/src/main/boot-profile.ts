/**
 * Startup segments, in milliseconds since the process started, printed as one JSON line
 * (`BOOT_PROFILE {...}`) when `DESKTOP_BOOT_PROFILE=1`. Every startup optimization is judged
 * against these numbers.
 */
export type BootMark =
  | "ready"
  | "utility-spawn"
  | "utility-ready"
  | "navigation-start"
  | "first-byte"
  | "dom-content-loaded"
  | "first-paint";

export interface BootProfile {
  readonly enabled: boolean;
  mark(name: BootMark): void;
  marks(): Partial<Record<BootMark, number>>;
  /** Extra numbers for the report that are not points in time (counts, statuses, durations). */
  note(name: string, value: number): void;
  notes(): Record<string, number>;
  /** Prints the marks once, after the first paint (or when told). */
  report(): void;
}

export function createBootProfile(enabled = process.env.DESKTOP_BOOT_PROFILE === "1"): BootProfile {
  const marks: Partial<Record<BootMark, number>> = {};
  const notes: Record<string, number> = {};
  let reported = false;
  return {
    enabled,
    mark(name) {
      marks[name] ??= Math.round(process.uptime() * 1000);
    },
    marks: () => ({ ...marks }),
    note(name, value) {
      notes[name] = value;
    },
    notes: () => ({ ...notes }),
    report() {
      if (!enabled || reported) return;
      reported = true;
      process.stdout.write(`BOOT_PROFILE ${JSON.stringify({ ...marks, ...notes })}\n`);
    },
  };
}
