import { ChildProcess } from "node:child_process";

import { expect, it, vi } from "vitest";

import { devElectron, waitForHttp, watchRequiredWorker } from "./dev.ts";

function instance() {
  let resolve!: (code: number | null) => void;
  const finished = new Promise<number | null>((done) => {
    resolve = done;
  });
  return {
    child: new ChildProcess(),
    finished,
    stop: vi.fn<() => Promise<void>>(async () => {
      await finished;
    }),
    resolve,
  };
}

it("coalesces rebuilds until the previous instance finishes cleanup", async () => {
  const first = instance();
  const second = instance();
  const start = vi.fn<typeof instance>().mockReturnValueOnce(first).mockReturnValueOnce(second);
  const exited = vi.fn<(code: number) => void>();
  const app = devElectron(start, () => false, exited);
  app.restart();
  app.restart();
  app.restart();
  expect(first.stop).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledTimes(1);
  first.resolve(0);
  await vi.waitFor(() => expect(app.current).toBe(second.child));
  expect(exited).not.toHaveBeenCalled();
  second.resolve(7);
  await vi.waitFor(() => expect(exited).toHaveBeenCalledWith(7));
});

it("waits for an in-flight restart on shutdown and does not launch its replacement", async () => {
  const old = instance();
  const start = vi.fn<typeof instance>(() => old);
  let closing = false;
  const app = devElectron(start, () => closing, vi.fn<(code: number) => void>());
  app.restart();
  app.restart();
  closing = true;
  const stopped = app.stop();
  expect(old.stop).toHaveBeenCalledTimes(1);
  old.resolve(0);
  await stopped;
  expect(start).toHaveBeenCalledTimes(1);
});

it("shuts down when a required worker exits unexpectedly after startup, and ignores exits during shutdown", () => {
  const exited = vi.fn<(code: number) => void>();
  const crashed = new ChildProcess();
  watchRequiredWorker(crashed, "vite:main", () => false, exited);
  crashed.emit("exit", 1, null);
  expect(exited).toHaveBeenCalledExactlyOnceWith(1);

  const closing = new ChildProcess();
  watchRequiredWorker(closing, "web", () => true, exited);
  closing.emit("exit", 0, "SIGTERM");
  expect(exited).toHaveBeenCalledTimes(1);
});

const stalledFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
  });

it("aborts a stalled health request when waitForHttp hits its deadline", async () => {
  await expect(waitForHttp("http://127.0.0.1:5174/api/health", 40, stalledFetch)).rejects.toThrow(
    "did not answer within 40 ms",
  );
});
