import type { CookieStore } from "@repo/electron-cookies/main";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { COOKIE_JAR_ORIGIN } from "./app-url.ts";
import { createBootProfile } from "./boot-profile.ts";
import { COOKIE_STORE_PROBE_INTERVAL_MS, COOKIE_STORE_STARTUP_TIMEOUT_MS, openFirstWindow } from "./first-window.ts";
import type { Logger } from "./log.ts";

function start() {
  let answer!: (cookies: []) => void;
  let reject!: (err: Error) => void;
  const read = new Promise<[]>((resolve, fail) => {
    answer = resolve;
    reject = fail;
  });
  const store = { get: vi.fn<CookieStore["get"]>(() => read) };
  const log = { warn: vi.fn<Logger["warn"]>() };
  const profile = createBootProfile(true);
  const open = vi.fn<() => void>();
  const opened = openFirstWindow(store, log, profile, open);
  return { answer, reject, store, log, profile, open, opened };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("waits for the application cookie store before opening the first window", async () => {
  const { answer, store, log, profile, open, opened } = start();
  expect(store.get).toHaveBeenCalledExactlyOnceWith({ url: COOKIE_JAR_ORIGIN });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(open).not.toHaveBeenCalled();
  answer([]);
  await opened;
  expect(open).toHaveBeenCalledOnce();
  expect(profile.notes()["cookie-store-wait-ms"]).toBe(10_000);
  expect(log.warn).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("opens on the next probe when the first read never settles", async () => {
  const { store, log, profile, open, opened } = start();
  store.get.mockResolvedValueOnce([]);
  await vi.advanceTimersByTimeAsync(COOKIE_STORE_PROBE_INTERVAL_MS);
  await opened;
  expect(store.get).toHaveBeenCalledTimes(2);
  expect(open).toHaveBeenCalledOnce();
  expect(profile.notes()["cookie-store-wait-ms"]).toBe(COOKIE_STORE_PROBE_INTERVAL_MS);
  expect(log.warn).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("warns and opens the first window at the fallback deadline", async () => {
  const { reject, store, log, profile, open, opened } = start();
  await vi.advanceTimersByTimeAsync(COOKIE_STORE_STARTUP_TIMEOUT_MS - 1);
  expect(open).not.toHaveBeenCalled();
  expect(log.warn).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await opened;
  expect(open).toHaveBeenCalledOnce();
  expect(profile.notes()["cookie-store-wait-ms"]).toBe(COOKIE_STORE_STARTUP_TIMEOUT_MS);
  expect(store.get).toHaveBeenCalledTimes(COOKIE_STORE_STARTUP_TIMEOUT_MS / COOKIE_STORE_PROBE_INTERVAL_MS);
  expect(log.warn).toHaveBeenCalledExactlyOnceWith(
    { timeoutMs: COOKIE_STORE_STARTUP_TIMEOUT_MS },
    "cookie store timed out before first window",
  );
  reject(new Error("late store rejection"));
  await vi.advanceTimersByTimeAsync(0);
  expect(log.warn).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledOnce();
});

it("warns and opens the first window immediately when the store rejects", async () => {
  const { reject, log, open, opened } = start();
  reject(new Error("private store details"));
  await opened;
  expect(log.warn).toHaveBeenCalledExactlyOnceWith(
    { operation: "cookies.get" },
    "cookie store read failed before first window",
  );
  expect(open).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
