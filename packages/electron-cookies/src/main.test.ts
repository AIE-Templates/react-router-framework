import { afterEach, describe, expect, it, vi } from "vitest";

import { createCookieJar, MAX_SET_COOKIES_PER_RESPONSE } from "./main.ts";
import { OMIT_COOKIES_HEADER } from "./shared.ts";
import {
  type CookieStore,
  CookieStoreTimeoutError,
  flushForQuit,
  QUIT_FLUSH_TIMEOUT_MS,
  STORE_TIMEOUT_MS,
} from "./store.ts";
import { fakeCookieStore as fakeStore } from "./testing/fake-store.ts";
type LogFn = (data: Record<string, unknown>, msg: string) => void;
const logger = () => ({ debug: vi.fn<LogFn>(), warn: vi.fn<LogFn>() });
const COOKIE_JAR_ORIGIN = "https://app.desktop";
const origin = "xxx-app://site";
const req = (path = "/", initiatorOrigin?: string, headers = new Headers()) => ({ path, initiatorOrigin, headers });
function setup(store: CookieStore = fakeStore(), log = logger(), timeoutMs = STORE_TIMEOUT_MS) {
  const probe = fakeStore();
  const session = { cookies: probe };
  const fromPartition = vi.fn<(partition: string) => typeof session>(() => session);
  const installPermissionPolicy = vi.fn<(_session: typeof session) => void>();
  const jar = createCookieJar({
    scheme: "xxx-app",
    host: "site",
    origin,
    storageOrigin: COOKIE_JAR_ORIGIN,
    upstreamHost: "127.0.0.1",
    store,
    fromPartition,
    installPermissionPolicy,
    log,
    timeoutMs,
  });
  return { jar, probe, fromPartition, installPermissionPolicy, log };
}

function response(...setCookies: string[]): Headers {
  const headers = new Headers();
  for (const value of setCookies) headers.append("set-cookie", value);
  return headers;
}

describe("createCookieJar", () => {
  it("stores Set-Cookie host-only under the jar origin and sends it back on matching paths", async () => {
    const store = fakeStore();
    const { jar } = setup(store);

    await jar.storeResponseCookies(response("sid=1; Path=/; HttpOnly", "scoped=2; Path=/api"), req("/login"));
    expect(store.set).toHaveBeenCalledWith({
      url: `${COOKIE_JAR_ORIGIN}/`,
      name: "sid",
      value: "1",
      path: "/",
      secure: false,
      httpOnly: true,
      sameSite: "unspecified",
    });
    expect(store.set).toHaveBeenCalledWith(expect.objectContaining({ url: `${COOKIE_JAR_ORIGIN}/api`, path: "/api" }));
    expect(store.set.mock.calls.every(([details]) => !("domain" in details))).toBe(true);

    expect(await jar.cookieHeader(req("/"))).toBe("sid=1");
    expect(await jar.cookieHeader(req("/api/users"))).toBe("scoped=2; sid=1");
    expect(await jar.cookieHeader(req("/apiary"))).toBe("sid=1");
    expect(store.get).toHaveBeenCalledWith({ url: `${COOKIE_JAR_ORIGIN}/apiary` });
  });

  it("answers no header when no cookie applies", async () => {
    const { jar } = setup(fakeStore());
    expect(await jar.cookieHeader(req("/"))).toBeUndefined();
  });

  it("deletes with an expired set of the same name and path, and flushes after every change", async () => {
    const store = fakeStore();
    const { jar } = setup(store);
    await jar.storeResponseCookies(response("sid=1; Path=/; HttpOnly"), req("/"));
    expect(store.flushStore).toHaveBeenCalledTimes(1);

    await jar.storeResponseCookies(response("keep=1; Path=/; Max-Age=60"), req("/"));
    expect(store.flushStore).toHaveBeenCalledTimes(2);

    await jar.storeResponseCookies(response("sid=; Path=/; Max-Age=0"), req("/"));
    expect(store.set).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: `${COOKIE_JAR_ORIGIN}/`,
        name: "sid",
        path: "/",
        httpOnly: true,
        expirationDate: 1,
      }),
    );
    expect(store.flushStore).toHaveBeenCalledTimes(3);
    expect(await jar.cookieHeader(req("/"))).toBe("keep=1");
  });

  it("flushes when a session cookie replaces a persistent one, so the old value is gone from the disk", async () => {
    const store = fakeStore();
    const { jar } = setup(store);
    await jar.storeResponseCookies(response("sid=old; Path=/; Max-Age=600"), req("/"));
    expect(store.disk.map((c) => `${c.name}=${c.value}`)).toEqual(["sid=old"]);

    await jar.storeResponseCookies(response("sid=new; Path=/"), req("/"));
    expect(await jar.cookieHeader(req("/"))).toBe("sid=new");
    // What a relaunch after a hard kill would load: no persistent sid any more.
    expect(store.disk).toEqual([]);
  });

  it("does not flush when nothing was stored", async () => {
    const store = fakeStore();
    const { jar } = setup(store);
    await jar.storeResponseCookies(response("bad=1; Domain=evil.example"), req("/"));
    expect(store.flushStore).not.toHaveBeenCalled();
  });

  it("applies cookies in header order, so a later one with the same name and path wins", async () => {
    const store = fakeStore();
    const { jar } = setup(store);
    await jar.storeResponseCookies(response("a=1; Path=/", "a=2; Path=/"), req("/"));
    expect(await jar.cookieHeader(req("/"))).toBe("a=2");
  });

  it("handles at most MAX_SET_COOKIES_PER_RESPONSE cookies per response", async () => {
    const store = fakeStore();
    const { jar } = setup(store);
    const many = Array.from({ length: MAX_SET_COOKIES_PER_RESPONSE + 5 }, (_, i) => `c${i}=1; Path=/`);
    await jar.storeResponseCookies(response(...many), req("/"));
    expect(store.cookies).toHaveLength(MAX_SET_COOKIES_PER_RESPONSE);
  });

  it("does nothing for a response without Set-Cookie", async () => {
    const store = fakeStore();
    const { jar } = setup(store);
    await jar.storeResponseCookies(new Headers({ "content-type": "text/html" }), req("/"));
    expect(store.set).not.toHaveBeenCalled();
    expect(store.flushStore).not.toHaveBeenCalled();
  });
});

/** A store call in flight when the network service dies: it never settles. */
const never = () => new Promise<never>(() => {});

describe("createCookieJar with a store that stops answering", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a lookup with CookieStoreTimeoutError after the timeout, and answers again once the store does", async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const log = logger();
    const { jar } = setup(store, log);
    await jar.storeResponseCookies(response("sid=1; Path=/"), req("/"));
    store.get.mockImplementationOnce(never);
    let outcome: unknown;
    const lookup = jar.cookieHeader(req("/")).then(
      (value) => (outcome = value),
      (err: unknown) => (outcome = err),
    );
    await vi.advanceTimersByTimeAsync(STORE_TIMEOUT_MS - 1);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await lookup;
    expect(outcome).toBeInstanceOf(CookieStoreTimeoutError);
    expect(outcome).toMatchObject({ timeoutMs: STORE_TIMEOUT_MS });
    // The fault is gone: the next lookup answers, and nothing is left on the clock.
    expect(await jar.cookieHeader(req("/"))).toBe("sid=1");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops waiting for a lookup when the request is cancelled, without a warning", async () => {
    const store = fakeStore();
    const log = logger();
    const { jar } = setup(store, log);
    store.get.mockImplementationOnce(never);
    const controller = new AbortController();
    const lookup = jar.cookieHeader(req("/"), controller.signal);
    controller.abort();
    expect(await lookup).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("gives up on a response's cookies after one timeout for all of them, with a warning and no flush", async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const log = logger();
    const { jar } = setup(store, log);
    store.set.mockImplementationOnce(never);
    let settled = false;
    const stored = jar
      .storeResponseCookies(response("a=1; Path=/", "b=2; Path=/"), req("/"))
      .then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(STORE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stored;
    expect(store.set).toHaveBeenCalledTimes(2);
    expect(store.flushStore).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith({ timeoutMs: STORE_TIMEOUT_MS }, expect.stringContaining("timed out"));
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("a=1");
    // The fault is gone: the next response's cookies are stored and flushed.
    await jar.storeResponseCookies(response("c=3; Path=/"), req("/"));
    expect(await jar.cookieHeader(req("/"))).toBe("b=2; c=3");
    expect(store.flushStore).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up on a flush that never answers, keeping what the store already has", async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const log = logger();
    const { jar } = setup(store, log, 100);
    store.flushStore.mockImplementationOnce(never);
    const stored = jar.storeResponseCookies(response("a=1; Path=/"), req("/"));
    await vi.advanceTimersByTimeAsync(100);
    await stored;
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith({ timeoutMs: 100 }, expect.stringContaining("timed out"));
    expect(await jar.cookieHeader(req("/"))).toBe("a=1");
  });
});

describe("flushForQuit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves once the store has flushed", async () => {
    const store = fakeStore();
    const log = logger();
    await flushForQuit(store, log);
    expect(store.flushStore).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("gives up after the timeout when the store never answers, with a warning", async () => {
    vi.useFakeTimers();
    const log = logger();
    let settled = false;
    const done = flushForQuit({ flushStore: () => new Promise<void>(() => {}) }, log, QUIT_FLUSH_TIMEOUT_MS).then(
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(QUIT_FLUSH_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(log.warn).toHaveBeenCalledWith({ timeoutMs: QUIT_FLUSH_TIMEOUT_MS }, expect.stringContaining("timed out"));
  });

  it("never rejects when the flush fails", async () => {
    const log = logger();
    await expect(
      flushForQuit({ flushStore: async () => Promise.reject(new Error("gone")) }, log),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe("server cookie writes", () => {
  it("passes Secure Partitioned writes to the ordinary store and ignores Partitioned without Secure", async () => {
    const store = fakeStore();
    const { jar } = setup(store);
    await jar.storeResponseCookies(response("key=plain", "key=partitioned; Secure; Partitioned"), req());
    expect(await jar.cookieHeader(req())).toBe("key=partitioned");
    await jar.storeResponseCookies(response("key=illegal; Partitioned"), req());
    expect(store.set).toHaveBeenCalledTimes(2);
    await jar.storeResponseCookies(response("key=again"), req());
    expect(await jar.cookieHeader(req())).toBe("key=again");
  });

  it("recovers from a failed lookup and flush without logging cookie values", async () => {
    const store = fakeStore();
    const { jar, log } = setup(store);
    store.flushStore.mockRejectedValueOnce(new Error("store unavailable"));
    await jar.storeResponseCookies(response("sid=secret"), req());
    store.get.mockRejectedValueOnce(new Error("store unavailable"));
    expect(await jar.cookieHeader(req())).toBeUndefined();
    await jar.storeResponseCookies(response("sid=recovered"), req());
    expect(await jar.cookieHeader(req())).toBe("sid=recovered");
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("secret");
  });

  it("maps a dev Domain on set and expiry and keeps the host-only cookie separate", async () => {
    const store = fakeStore();
    const { jar } = setup(store);
    await jar.storeResponseCookies(response("sid=host", "sid=domain; Domain=.127.0.0.1; HttpOnly"), req());
    expect(store.cookies).toEqual([
      expect.objectContaining({ value: "host", httpOnly: false, secure: false, sameSite: "unspecified" }),
      expect.objectContaining({ value: "domain", domain: "app.desktop", url: COOKIE_JAR_ORIGIN + "/", httpOnly: true }),
    ]);
    await jar.storeResponseCookies(response("sid=; Max-Age=0; Domain=.APP.DESKTOP"), req());
    expect(await jar.cookieHeader(req())).toBe("sid=host");
    expect(store.set).toHaveBeenLastCalledWith(
      expect.objectContaining({ domain: "app.desktop", httpOnly: true, expirationDate: 1 }),
    );
    await jar.storeResponseCookies(
      response("sid=wrong; Domain=DESKTOP", "__Host-sid=x; Secure; Path=/; Domain=.127.0.0.1"),
      req(),
    );
    expect(store.set).toHaveBeenCalledWith(expect.objectContaining({ domain: "desktop" }));
    expect(await jar.cookieHeader(req())).toBe("sid=host");
  });

  it("uses the response Date only for Expires", async () => {
    const store = fakeStore();
    const { jar } = setup(store);
    const headers = response("sid=1; Expires=28 Oct 2026 13:00:00 GMT", "other=2; Max-Age=70");
    headers.set("date", "Wed, 28 Oct 2026 12:00:00 GMT");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(2026, 10, 3));
      await jar.storeResponseCookies(headers, req());
      expect(store.cookies.map((c) => c.expirationDate)).toEqual([Date.now() / 1000 + 3600, Date.now() / 1000 + 70]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes a 4096-byte HttpOnly name without growing its empty value past the limit", async () => {
    const { jar } = setup(fakeStore());
    const name = "n".repeat(4096);
    await jar.storeResponseCookies(response(name + "=; HttpOnly"), req());
    expect(await jar.cookieHeader(req())).toBe(name + "=");
    await jar.storeResponseCookies(response(name + "=; Max-Age=0"), req());
    expect(await jar.cookieHeader(req())).toBeUndefined();
  });

  it("round trips UTF-8 and nameless cookies and skips just the header with invalid bytes", async () => {
    const store = fakeStore();
    const { jar, log } = setup(store);
    const text = Buffer.from("中文", "utf8").toString("latin1");
    await jar.storeResponseCookies(response(text, "k=" + text, "bad=secret\xe9"), req());
    expect(store.cookies.map((c) => c.value)).toEqual(["中文", "中文"]);
    expect(await jar.cookieHeader(req())).toBe(text + "; k=" + text);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("secret");
    await jar.storeResponseCookies(response("=other"), req());
    expect(await jar.cookieHeader(req())).toBe("k=" + text + "; other");
    await jar.storeResponseCookies(response("=; Max-Age=0"), req());
    expect(await jar.cookieHeader(req())).toBe("k=" + text + "; other");
    await jar.storeResponseCookies(response("=delete; Max-Age=0"), req());
    expect(await jar.cookieHeader(req())).toBe("k=" + text);
  });

  it.each([
    [origin, false, true],
    [undefined, false, true],
    [undefined, true, false],
    [origin, true, false],
    ["null", false, false],
    ["", false, false],
    ["xxx-app://other", false, false],
    ["media://site", false, false],
    ["https://site", false, false],
  ] as const)("applies source %s and omit %s before touching the store", async (source, omit, allowed) => {
    const store = fakeStore();
    const { jar } = setup(store);
    const request = req("/", source, new Headers(omit ? { [OMIT_COOKIES_HEADER]: "1" } : {}));
    await jar.storeResponseCookies(response("sid=v"), request);
    expect(await jar.cookieHeader(request)).toBe(allowed ? "sid=v" : undefined);
    expect(store.set).toHaveBeenCalledTimes(Number(allowed));
    expect(store.get).toHaveBeenCalledTimes(Number(allowed));
    expect(store.flushStore).toHaveBeenCalledTimes(Number(allowed));
  });

  it("submits each complete batch in header order before yielding", async () => {
    const store = fakeStore();
    const { jar } = setup(store);
    const a = jar.storeResponseCookies(response("x=a", "y=a"), req());
    const b = jar.storeResponseCookies(response("y=b", "x=b"), req());
    expect(store.set.mock.calls.map(([c]) => [c.name, c.value])).toEqual([
      ["x", "a"],
      ["y", "a"],
      ["y", "b"],
      ["x", "b"],
    ]);
    await Promise.all([a, b]);
    expect(store.cookies.map((c) => c.value)).toEqual(["b", "b"]);
  });

  it.each([
    ["__Secure-sid", "bad"],
    ["__Http-sid", "bad; Secure"],
    ["__http-sid", "bad; Secure"],
    ["sid", "x".repeat(4097)],
    ["sid", "bad; SameSite=None"],
  ])("preserves an old HttpOnly %s when Chromium rejects the probe", async (name, invalid) => {
    const store = fakeStore();
    const { jar, probe, fromPartition, installPermissionPolicy } = setup(store);
    await jar.storeResponseCookies(response(name + "=old; Secure; HttpOnly"), req());
    expect(fromPartition).not.toHaveBeenCalled();
    await jar.storeResponseCookies(response(name + "=" + invalid), req());
    expect(fromPartition).toHaveBeenCalledOnce();
    expect(fromPartition.mock.calls[0][0]).not.toMatch(/^persist:/);
    expect(installPermissionPolicy).toHaveBeenCalledWith({ cookies: probe });
    expect(installPermissionPolicy.mock.invocationCallOrder[0]).toBeLessThan(probe.set.mock.invocationCallOrder[0]);
    expect(store.cookies).toEqual([expect.objectContaining({ value: "old", httpOnly: true })]);
    expect(store.set.mock.calls.slice(1).every(([c]) => !c.httpOnly && c.expirationDate === undefined)).toBe(true);
    expect(store.flushStore).toHaveBeenCalledOnce();
  });

  it.each([
    ["sid=2; HttpOnly", "2", true],
    ["sid=" + "x".repeat(4097), "1", false],
    ["sid=; Max-Age=0", undefined, undefined],
    ["sid=2", "2", false],
  ] as const)("chooses the last write that can land in one batch (%#)", async (last, value, httpOnly) => {
    const store = fakeStore();
    const { jar } = setup(store);
    await jar.storeResponseCookies(response("sid=old; HttpOnly"), req());
    await jar.storeResponseCookies(response("sid=1", last), req());
    expect(store.cookies.map((c) => [c.value, c.httpOnly])).toEqual(value === undefined ? [] : [[value, httpOnly]]);
    expect(
      store.set.mock.calls.slice(1).some(([c]) => c.httpOnly && c.value === "1" && c.expirationDate === undefined),
    ).toBe(false);
  });

  it("keeps the protected cookie when installing the probe policy fails and retries with a fresh session", async () => {
    const store = fakeStore();
    const { jar, probe, installPermissionPolicy, fromPartition } = setup(store);
    await jar.storeResponseCookies(response("sid=old; HttpOnly"), req());
    installPermissionPolicy.mockImplementationOnce(() => {
      throw new Error("permission policy unavailable");
    });
    await jar.storeResponseCookies(response("sid=no"), req());
    expect(probe.set).not.toHaveBeenCalled();
    expect(store.cookies).toEqual([expect.objectContaining({ value: "old", httpOnly: true })]);
    await jar.storeResponseCookies(response("sid=ok"), req());
    expect(fromPartition.mock.calls[0][0]).not.toBe(fromPartition.mock.calls[1][0]);
    expect(store.cookies).toEqual([expect.objectContaining({ value: "ok", httpOnly: false })]);
  });

  it("retries normally when another response has already deleted the HttpOnly cookie", async () => {
    const store = fakeStore();
    const { jar, fromPartition } = setup(store);
    await jar.storeResponseCookies(response("sid=old; HttpOnly"), req());
    const a = jar.storeResponseCookies(response("sid=a"), req());
    const b = jar.storeResponseCookies(response("sid=; HttpOnly; Max-Age=0"), req());
    await Promise.all([a, b]);
    expect(fromPartition).not.toHaveBeenCalled();
    expect(store.cookies).toEqual([expect.objectContaining({ value: "a", httpOnly: false })]);
  });

  it("delivers B and allows reads while A is probing, then replaces without a visible gap", async () => {
    const store = fakeStore();
    const { jar, probe } = setup(store);
    const entered = gate();
    const release = gate();
    probe.set.mockImplementationOnce(async () => {
      entered.open();
      await release.promise;
    });
    await jar.storeResponseCookies(response("sid=old; HttpOnly"), req());
    const a = jar.storeResponseCookies(response("sid=a"), req());
    try {
      await entered.promise;
      await jar.storeResponseCookies(response("sid=b; HttpOnly"), req());
      expect(await jar.cookieHeader(req())).toBe("sid=b");
      await expect(store.set({ ...store.cookies[0], value: "script", httpOnly: false })).rejects.toThrow(
        "EXCLUDE_OVERWRITE_HTTP_ONLY",
      );
      const realSet = store.set.getMockImplementation()!;
      let between: Promise<string | undefined> | undefined;
      store.set.mockImplementationOnce(async (c) => {
        const done = realSet(c);
        // A reader at the next microtask would see an empty jar if the two calls were separated by await.
        between = Promise.resolve().then(() => jar.cookieHeader(req()));
        return done;
      });
      release.open();
      await a;
      expect(await between).toBe("sid=a");
      expect(store.cookies).toEqual([expect.objectContaining({ value: "a", httpOnly: false })]);
      expect(store.set.mock.calls.some(([c]) => c.value === "a" && c.httpOnly)).toBe(false);
    } finally {
      release.open();
      await a;
    }
  });

  it("serializes competing downgrades of the same identity, allowing other identities through", async () => {
    const store = fakeStore();
    const { jar, probe } = setup(store);
    const entered = gate();
    const release = gate();
    probe.set.mockImplementationOnce(async () => {
      entered.open();
      await release.promise;
    });
    await jar.storeResponseCookies(response("sid=old; HttpOnly", "other=old; HttpOnly"), req());
    const a = jar.storeResponseCookies(response("sid=a"), req());
    try {
      await entered.promise;
      const b = jar.storeResponseCookies(response("sid=b"), req());
      await jar.storeResponseCookies(response("other=new"), req());
      expect(probe.set.mock.calls.map(([c]) => c.name)).toEqual(["sid", "other"]);
      release.open();
      await Promise.all([a, b]);
      expect(store.cookies.find((c) => c.name === "sid")).toMatchObject({ value: "b", httpOnly: false });
      expect(store.set.mock.calls.filter(([c]) => c.name === "sid" && c.expirationDate === 1)).toHaveLength(1);
    } finally {
      release.open();
      await a;
    }
  });

  it.each(["rejected", "unknown"] as const)(
    "records %s on a failed replacement after deleting the old cookie",
    async (status) => {
      vi.useFakeTimers();
      const store = fakeStore();
      const { jar, probe, log } = setup(store);
      try {
        await jar.storeResponseCookies(response("sid=old; HttpOnly"), req());
        const realSet = store.set.getMockImplementation()!;
        probe.set.mockImplementationOnce(async () => {
          store.set.mockImplementationOnce(realSet).mockImplementationOnce(
            status === "unknown"
              ? never
              : async () => {
                  throw new Error("rejected");
                },
          );
        });
        const update = jar.storeResponseCookies(response("sid=earlier", "sid=new"), req());
        await vi.advanceTimersByTimeAsync(STORE_TIMEOUT_MS);
        await update;
        expect(store.cookies).toEqual([]);
        expect(log.warn).toHaveBeenCalledWith({ name: "sid", result: status }, expect.stringContaining("replacement"));
        expect(store.flushStore).toHaveBeenCalledTimes(status === "unknown" ? 1 : 2);
        await jar.storeResponseCookies(response("sid=ok"), req());
        expect(await jar.cookieHeader(req())).toBe("sid=ok");
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
