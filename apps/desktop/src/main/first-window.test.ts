import { createCookieJar, type CookieStore } from "@electron-webhost/cookies/main";
import { serializeVisualCookie, visualCookie, visualRecordKernel } from "@repo/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { APP_HOST, APP_ORIGIN, COOKIE_JAR_ORIGIN } from "./app-url.ts";
import { createBootProfile } from "./boot-profile.ts";
import {
  COOKIE_STORE_PROBE_INTERVAL_MS,
  COOKIE_STORE_STARTUP_TIMEOUT_MS,
  openFirstWindow,
  syncFirstVisualCookie,
} from "./first-window.ts";
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

const raw = visualRecordKernel.encode({ version: 1, stamp: { t: 1, id: "native" }, preferences: { direction: "rtl" } });

function visualStartup(value?: string) {
  const stored =
    value === undefined
      ? []
      : [
          {
            name: visualCookie.name,
            value,
            path: "/",
            httpOnly: false,
            secure: false,
            session: false,
            sameSite: "lax" as const,
          },
        ];
  const store = {
    get: vi.fn<CookieStore["get"]>(async () => stored),
    set: vi.fn<CookieStore["set"]>(async () => {}),
    flushStore: async () => {},
  };
  const log = { warn: vi.fn<Logger["warn"]>(), debug: vi.fn<Logger["debug"]>() };
  const jar = createCookieJar({
    store,
    origin: APP_ORIGIN,
    host: APP_HOST,
    storageOrigin: COOKIE_JAR_ORIGIN,
    upstreamHost: "localhost",
    fromPartition: () => ({ cookies: store }),
    installPermissionPolicy: () => {},
    log,
  });
  const open = vi.fn<() => void>();
  const launch = (record: string | null) =>
    openFirstWindow(store, log, createBootProfile(false), open, (cookies) =>
      syncFirstVisualCookie(cookies, record, jar.script, log),
    );
  return { store, log, open, launch, jar };
}

it.each([undefined, "stale%20cookie"])(
  "waits for a page-identical cookie write before navigating (previous %s)",
  async (previous) => {
    const { store, open, launch, jar } = visualStartup(previous);
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    store.set.mockImplementationOnce(() => {
      started();
      return release;
    });
    const opening = launch(raw);
    try {
      await writing;
      expect(open).not.toHaveBeenCalled();
    } finally {
      finish();
      await opening;
    }
    expect(open).toHaveBeenCalledOnce();
    const [host] = store.set.mock.calls[0];
    expect(host).toMatchObject({
      name: visualCookie.name,
      value: encodeURIComponent(raw),
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "lax",
      url: COOKIE_JAR_ORIGIN + "/",
    });
    await jar.script.writeText(APP_ORIGIN + "/", serializeVisualCookie(raw, false), new AbortController().signal);
    expect(store.set.mock.calls[1]).toEqual([host]);
  },
);

it.each([
  [null, "keep"],
  [raw, encodeURIComponent(raw)],
] as const)("skips a missing mirror or equal cookie", async (record, cookie) => {
  const { store, open, launch } = visualStartup(cookie);
  await launch(record);
  expect(store.set).not.toHaveBeenCalled();
  expect(open).toHaveBeenCalledOnce();
});

it("logs a rejected pre-write, opens the window and recovers on a later launch", async () => {
  const { store, open, launch, log } = visualStartup("stale");
  store.set.mockRejectedValueOnce(new Error("cookie store unavailable"));
  await launch(raw);
  expect(log.warn).toHaveBeenCalledExactlyOnceWith({}, "visual cookie update failed before first window");
  expect(open).toHaveBeenCalledOnce();
  await launch(raw);
  expect(store.set).toHaveBeenCalledTimes(2);
  expect(open).toHaveBeenCalledTimes(2);
  expect(log.warn).toHaveBeenCalledOnce();
});
