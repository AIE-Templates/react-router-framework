/**
 * A preallocated latency histogram in microseconds: 1 µs buckets below 1 ms, 10 µs below 10 ms,
 * 100 µs below 100 ms, 1 ms below 1 s, 10 ms below 10 s, one overflow bucket. Recording is an
 * integer bucket increment, so it adds nothing measurable to the hot path.
 */
export class Histogram {
  static readonly #ranges = [
    { upToUs: 1_000, stepUs: 1 },
    { upToUs: 10_000, stepUs: 10 },
    { upToUs: 100_000, stepUs: 100 },
    { upToUs: 1_000_000, stepUs: 1_000 },
    { upToUs: 10_000_000, stepUs: 10_000 },
  ];

  readonly #counts: Uint32Array;
  readonly #offsets: number[];
  #count = 0;
  #maxUs = 0;
  #sumUs = 0;

  constructor() {
    const offsets: number[] = [];
    let total = 0;
    let from = 0;
    for (const { upToUs, stepUs } of Histogram.#ranges) {
      offsets.push(total);
      total += (upToUs - from) / stepUs;
      from = upToUs;
    }
    this.#offsets = offsets;
    this.#counts = new Uint32Array(total + 1);
  }

  record(ms: number): void {
    const us = ms * 1000;
    this.#count++;
    this.#sumUs += us;
    if (us > this.#maxUs) this.#maxUs = us;
    this.#counts[this.#bucket(us)]++;
  }

  get count(): number {
    return this.#count;
  }

  /** The value at `fraction` (0–1) in milliseconds, from the bucket's upper edge. */
  percentile(fraction: number): number {
    if (this.#count === 0) return 0;
    const target = Math.max(1, Math.ceil(fraction * this.#count));
    let seen = 0;
    for (let i = 0; i < this.#counts.length; i++) {
      seen += this.#counts[i] ?? 0;
      if (seen >= target) return this.#upperEdgeUs(i) / 1000;
    }
    return this.#maxUs / 1000;
  }

  summary(): HistogramSummary {
    return {
      samples: this.#count,
      p50Ms: round(this.percentile(0.5)),
      p95Ms: round(this.percentile(0.95)),
      p99Ms: round(this.percentile(0.99)),
      maxMs: round(this.#maxUs / 1000),
      meanMs: this.#count ? round(this.#sumUs / this.#count / 1000) : 0,
    };
  }

  #bucket(us: number): number {
    let from = 0;
    for (let r = 0; r < Histogram.#ranges.length; r++) {
      const { upToUs, stepUs } = Histogram.#ranges[r];
      if (us < upToUs) return (this.#offsets[r] ?? 0) + Math.floor((us - from) / stepUs);
      from = upToUs;
    }
    return this.#counts.length - 1;
  }

  #upperEdgeUs(index: number): number {
    for (let r = Histogram.#ranges.length - 1; r >= 0; r--) {
      const offset = this.#offsets[r] ?? 0;
      if (index >= offset) {
        if (index === this.#counts.length - 1) return this.#maxUs;
        const { stepUs } = Histogram.#ranges[r];
        const from = r === 0 ? 0 : Histogram.#ranges[r - 1].upToUs;
        return from + (index - offset + 1) * stepUs;
      }
    }
    return 0;
  }
}

export interface HistogramSummary {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}

export function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
