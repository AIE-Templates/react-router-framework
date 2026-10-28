import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { round } from "./histogram.ts";

/**
 * Process-level cost of a run: CPU time (user + system deltas over the window, for the process and
 * for the calling thread alone), memory sampled
 * every `intervalMs` with the peak kept, GC events and event-loop delay from `perf_hooks`. The
 * sampler is cheap enough to leave on during measurement; per-frame instrumentation is not.
 */
export interface MemorySample {
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export interface CpuMetrics {
  userMs: number;
  systemMs: number;
  totalMs: number;
  /** CPU seconds per wall second. */
  utilization: number;
}

export interface ProcessMetrics {
  wallMs: number;
  /**
   * The whole process: on the `worker` link the sender's and the peer's numbers are the same
   * process (both threads, plus V8's GC and compiler threads). Use `threadCpu` to tell them apart.
   */
  cpu: CpuMetrics;
  /** The calling thread only (`process.threadCpuUsage()`, Node 23.9+; absent on older Node). */
  threadCpu?: CpuMetrics;
  memory: { samples: number; peak: MemorySample; last: MemorySample; baseline: MemorySample };
  gc: { count: number; totalMs: number; maxMs: number };
  eventLoopDelay: { p50Ms: number; p99Ms: number; maxMs: number };
}

const KEYS = ["rss", "heapUsed", "external", "arrayBuffers"] as const;

export function startMetrics(intervalMs = 250): { stop(): ProcessMetrics } {
  const baseline = snapshot();
  const peak: MemorySample = { ...baseline };
  let last: MemorySample = baseline;
  let samples = 1;
  const timer = setInterval(() => {
    last = snapshot();
    samples++;
    for (const key of KEYS) {
      if (last[key] > peak[key]) peak[key] = last[key];
    }
  }, intervalMs);
  timer.unref();

  const gc = { count: 0, totalMs: 0, maxMs: 0 };
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gc.count++;
      gc.totalMs += entry.duration;
      if (entry.duration > gc.maxMs) gc.maxMs = entry.duration;
    }
  });
  observer.observe({ entryTypes: ["gc"] });

  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const cpuStart = process.cpuUsage();
  const threadCpuStart = process.threadCpuUsage?.();
  const wallStart = performance.now();

  return {
    stop() {
      const cpu = process.cpuUsage(cpuStart);
      const threadCpu = threadCpuStart && process.threadCpuUsage(threadCpuStart);
      const wallMs = performance.now() - wallStart;
      clearInterval(timer);
      observer.disconnect();
      loop.disable();
      last = snapshot();
      for (const key of KEYS) {
        if (last[key] > peak[key]) peak[key] = last[key];
      }
      return {
        wallMs: round(wallMs),
        cpu: cpuMetrics(cpu, wallMs),
        threadCpu: threadCpu && cpuMetrics(threadCpu, wallMs),
        memory: { samples, peak, last, baseline },
        gc: { count: gc.count, totalMs: round(gc.totalMs), maxMs: round(gc.maxMs) },
        eventLoopDelay: {
          p50Ms: round(loop.percentile(50) / 1e6),
          p99Ms: round(loop.percentile(99) / 1e6),
          maxMs: round(loop.max / 1e6),
        },
      };
    },
  };
}

function cpuMetrics(usage: NodeJS.CpuUsage, wallMs: number): CpuMetrics {
  const userMs = usage.user / 1000;
  const systemMs = usage.system / 1000;
  return {
    userMs: round(userMs),
    systemMs: round(systemMs),
    totalMs: round(userMs + systemMs),
    utilization: round((userMs + systemMs) / wallMs),
  };
}

/**
 * Runs a full garbage collection, for a memory reading after a measurement is over (what is still
 * referenced, not what V8 has not collected yet). Exposes `gc` on first use, without a command-line
 * flag; returns false where that is not possible.
 */
export function forceGc(): boolean {
  try {
    setFlagsFromString("--expose-gc");
    const gc: unknown = runInNewContext("gc");
    if (typeof gc !== "function") return false;
    gc();
    return true;
  } catch {
    return false;
  }
}

export function snapshot(): MemorySample {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers };
}
