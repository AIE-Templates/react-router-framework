import { expect, it, vi } from "vitest";

import { type CookieWrite, storeDeadline, writeCookie } from "./store.ts";
import { fakeCookieStore } from "./testing/fake-store.ts";

it("distinguishes a rejection with a reason from an unconfirmed write that can still land", async () => {
  vi.useFakeTimers();
  const store = fakeCookieStore();
  const deadline = storeDeadline(5000);
  const details: CookieWrite = {
    url: "https://example.test/",
    name: "k",
    value: "v",
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: "unspecified",
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const reason = new Error("rejected by store");
    store.set.mockRejectedValueOnce(reason);
    expect(await writeCookie(store, details, deadline.signal)).toEqual({ status: "rejected", reason });
    const realSet = store.set.getMockImplementation()!;
    store.set.mockImplementationOnce(async (cookie) => {
      await gate;
      await realSet(cookie);
    });
    const pending = writeCookie(store, details, deadline.signal);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ status: "unknown" });
    expect(store.cookies).toEqual([]);
    release();
    await store.set.mock.results[1].value;
    expect(store.cookies).toEqual([details]);
    expect(await writeCookie(store, details, new AbortController().signal)).toEqual({ status: "stored" });
  } finally {
    release();
    deadline.clear();
    vi.useRealTimers();
  }
});
