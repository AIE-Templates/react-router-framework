/**
 * Up-front checks for numeric options: a nonsensical value (negative, fractional where bytes are
 * meant, `NaN`, `Infinity`, a timer longer than timers allow) throws a `RangeError` when the
 * channel or relay is created instead of corrupting counters later.
 */

/** The longest delay `setTimeout` honours; longer ones fire at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** `value`, when given, is a safe integer of at least `min`. */
export function checkInteger(name: string, value: number | undefined, min: number): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer of at least ${min}, got ${String(value)}`);
  }
}

/** `value`, when given, is a finite duration a timer can wait: at least `min`, above 0 when `min` is 0 and `positive`. */
export function checkMs(name: string, value: number | undefined, { positive }: { positive: boolean }): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0 || (positive && value === 0) || value > MAX_TIMER_MS) {
    const range = positive ? "above 0" : "at least 0";
    throw new RangeError(
      `${name} must be a number of milliseconds ${range} and at most ${MAX_TIMER_MS}, got ${String(value)}`,
    );
  }
}

/** Builds the stats snapshot `stats()` returns: a copy, with fractional milliseconds rounded. */
export function snapshot<T extends { drainWaitMs?: number }>(stats: T): T {
  const copy = { ...stats };
  if (copy.drainWaitMs !== undefined) copy.drainWaitMs = Math.round(copy.drainWaitMs);
  return copy;
}

/** A monotonic clock in milliseconds (Node and browsers both have `performance`). */
export const now = (): number => performance.now();
