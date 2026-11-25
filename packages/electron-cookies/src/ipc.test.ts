import { EventEmitter } from "node:events";

import type { Cookie, IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCookieJar,
  installCookieIpc,
  STORE_TIMEOUT_MS,
  SYNC_STORE_PROBE_TIMEOUT_MS,
  SYNC_STORE_TIMEOUT_MS,
} from "./main.ts";
import { cookieIpcChannels, type CookieReply, type WindowCookie } from "./shared.ts";
import { fakeCookieStore } from "./testing/fake-store.ts";

const origin = "xxx-app://site";
const url = origin + "/dir/page";
const storageOrigin = "https://jar.example";
const channels = cookieIpcChannels("test");
const note: Cookie = { name: "lang", value: "zh", path: "/", domain: "jar.example", sameSite: "lax" };
const input: WindowCookie = {
  name: "id",
  value: "new",
  path: "/",
  domain: null,
  secure: true,
  expires: null,
  sameSite: "strict",
  partitioned: false,
};
const never = () => new Promise<never>(() => {});

function makeFrame() {
  return {
    origin,
    url: origin + "/push-state",
    detached: false,
    isDestroyed: () => false,
    send: vi.fn<(...args: unknown[]) => void>(),
  };
}

function setup() {
  const store = fakeCookieStore();
  const session = {};
  const sender = { session };
  const frame = makeFrame();
  const event = { sender, senderFrame: frame as ReturnType<typeof makeFrame> | null };
  const ipc = new EventEmitter();
  type Invoke = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<CookieReply<unknown>>;
  const invokes = new Map<string, Invoke>();
  const changes = new EventEmitter();
  const log = { warn: vi.fn<() => void>(), debug: vi.fn<() => void>() };
  const jar = createCookieJar({
    store,
    storageOrigin,
    scheme: "xxx-app",
    host: "site",
    origin,
    upstreamHost: "localhost",
    log,
    fromPartition: () => ({ cookies: fakeCookieStore() }),
    installPermissionPolicy: () => {},
  });
  installCookieIpc({
    jar,
    prefix: "test",
    log,
    changes,
    ipcMain: Object.assign(ipc, { handle: (key: string, fn: Invoke) => invokes.set(key, fn) }),
    ownsSender: (contents) => Object.is(contents, sender) && contents.session === session,
    isAppUrl: (value) =>
      URL.canParse(value) && new URL(value).protocol === "xxx-app:" && new URL(value).host === "site",
  });
  function sync(channel: string, target: string, ...args: unknown[]) {
    return new Promise<unknown>((resolve) => {
      ipc.emit(
        channel,
        {
          ...event,
          set returnValue(reply: unknown) {
            resolve(reply);
          },
        },
        target,
        ...args,
      );
    });
  }
  function invoke(channel: string, target: string, ...args: unknown[]) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only Electron can create a real invoke event.
    return invokes.get(channel)!(event as unknown as IpcMainInvokeEvent, target, ...args);
  }
  const read = (target = url) => sync(channels.get, target);
  const write = (text: string, target = url) => sync(channels.set, target, text);
  const register = (target = url, documentId = "doc") => ipc.emit(channels.register, event, target, documentId);
  const change = (cookie: Cookie = note, cause = "inserted") => changes.emit("changed", {}, cookie, cause, false);
  return { event, store, frame, read, write, register, change, invoke, jar };
}

afterEach(() => vi.useRealTimers());

describe("window cookie IPC", () => {
  it("shares server, text and structured writes, preserving domain identity, visibility and path order", async () => {
    const { jar, store, read, write, invoke } = setup();
    await jar.storeResponseCookies(new Headers({ "set-cookie": "id=server; Domain=localhost; Path=/" }), {
      path: "/",
      headers: new Headers(),
    });
    await write("id=script; Domain=.SiTe; Path=/");
    await write("id=host; Path=/");
    await write("中文; Partitioned; Secure");
    await write("ignored=bad; Partitioned");
    await write("other=bad; Domain=jar.example");
    await write("bad=secret; HttpOnly");
    expect(await read()).toBe("中文; id=script; id=host");
    expect(await read(origin + "/dir2")).toBe("id=script; id=host");
    const all = () => invoke(channels.getAll, url, "id");
    expect(await all()).toEqual({
      ok: true,
      value: [
        { ...input, domain: "site", value: "script", sameSite: "lax", secure: false },
        { ...input, value: "host", sameSite: "lax", secure: false },
      ],
    });
    expect(await invoke(channels.storeSet, url, { ...input, domain: "site", expires: 0 })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await read()).toBe("中文; id=host");
    expect(store.flushStore).toHaveBeenCalledOnce();
    await jar.storeResponseCookies(new Headers({ "set-cookie": "id=private; Path=/; HttpOnly" }), {
      path: "/",
      headers: new Headers(),
    });
    await write("id=wrong; Path=/");
    for (const expires of [null, 0]) {
      expect(await invoke(channels.storeSet, url, { ...input, expires })).toMatchObject({
        ok: false,
        error: { name: "TypeError" },
      });
    }
    expect(await all()).toEqual({ ok: true, value: [] });
    expect(await read()).toBe("中文");
    expect(await jar.cookieHeader({ path: "/", headers: new Headers() })).toBe("id=private");
  });

  it("validates every channel before reading even a cached value and allows detached pagehide writes", async () => {
    const { event, frame, read, write, invoke, register, change, store } = setup();
    await write("lang=zh");
    expect(await read()).toBe("lang=zh");
    store.get.mockClear();
    store.set.mockClear();
    const sender = event.sender;
    for (const [senderFrame, contents, target] of [
      [null, sender, url],
      [{ ...frame, origin: "null" }, sender, url],
      [{ ...frame, origin: "https://site" }, sender, url],
      [frame, { session: {} }, url],
      [frame, sender, "https://site/dir"],
      [frame, sender, "xxx-app://other/dir"],
      [frame, sender, "not a URL"],
    ] as const) {
      event.senderFrame = senderFrame;
      event.sender = contents;
      expect(await read(target)).toBe("");
      expect(await write("oops=1", target)).toBeNull();
      for (const key of [channels.getAll, channels.storeSet])
        expect(await invoke(key, target)).toMatchObject({ ok: false, error: { name: "SecurityError" } });
      register(target);
    }
    change();
    expect(frame.send).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
    Object.assign(event, { senderFrame: frame, sender });
    frame.detached = true;
    const pending = write("leaving=yes");
    event.senderFrame = null;
    await pending;
    expect(store.set).toHaveBeenCalledOnce();
    event.senderFrame = frame;
    expect(await read()).toBe("lang=zh; leaving=yes");
  });

  it("validates structured IPC payloads before writing and never accepts a privileged flag", async () => {
    const { store, invoke } = setup();
    for (const bad of [
      null,
      {},
      { ...input, domain: "jar.example" },
      { ...input, domain: ".site" },
      { ...input, expires: Infinity },
      { ...input, secure: false },
      { ...input, sameSite: "bogus" },
      { ...input, name: "a=b" },
      { ...input, value: "value; Max-Age=0" },
      { ...input, name: "__Http-x" },
      { ...input, path: "relative" },
    ]) {
      expect(await invoke(channels.storeSet, url, bad)).toMatchObject({ ok: false, error: { name: "TypeError" } });
    }
    expect(store.set).not.toHaveBeenCalled();
    expect(await invoke(channels.storeSet, url, { ...input, httpOnly: true, url: "https://external/" })).toMatchObject({
      ok: true,
    });
    expect(store.set).toHaveBeenCalledWith(
      expect.objectContaining({ httpOnly: false, url: storageOrigin + "/", sameSite: "strict", secure: true }),
    );
  });

  it.each([
    ["unspecified", {}],
    ["lax", { sameSite: "lax" }],
    ["strict", { sameSite: "strict" }],
    ["no_restriction", { sameSite: "none" }],
  ] as const)("reports the stored SameSite %s on deletion", (sameSite, attribute) => {
    const { frame, register, change } = setup();
    register();
    change({ ...note, sameSite }, "expired-overwrite");
    expect(frame.send.mock.calls).toStrictEqual([
      [
        channels.changed,
        {
          documentId: "doc",
          changed: [],
          deleted: [{ name: note.name, domain: null, path: "/", secure: false, partitioned: false, ...attribute }],
        },
      ],
    ]);
  });

  it("omits unspecified SameSite only from deletion dictionaries", () => {
    const { frame, register, change } = setup();
    register();
    const cookie = { ...note, sameSite: "unspecified" } as const;
    change(cookie, "inserted");
    expect(frame.send).toHaveBeenLastCalledWith(channels.changed, {
      documentId: "doc",
      changed: [expect.objectContaining({ sameSite: "lax" })],
      deleted: [],
    });
    for (const cause of ["explicit", "expired-overwrite", "expired", "evicted"]) {
      change(cookie, cause);
      expect(frame.send).toHaveBeenLastCalledWith(channels.changed, {
        documentId: "doc",
        changed: [],
        deleted: [{ name: "lang", domain: null, path: "/", secure: false, partitioned: false }],
      });
    }
  });

  it("filters pushes per registered document and path, maps causes, and prunes dead registrations", () => {
    const { event, frame, register, change } = setup();
    change();
    expect(frame.send).not.toHaveBeenCalled();
    register(url, "old");
    register(url, "new");
    const sibling = makeFrame();
    event.senderFrame = sibling;
    register(origin + "/directory", "sibling");
    const scoped = { ...note, domain: ".jar.example", path: "/dir" };
    for (const cause of ["overwrite", "inserted-no-change-overwrite"]) change(scoped, cause);
    change({ ...scoped, httpOnly: true });
    change({ ...scoped, domain: "external.test" });
    expect(frame.send).not.toHaveBeenCalled();
    for (const cause of ["inserted", "inserted-no-value-change-overwrite"]) change(scoped, cause);
    const row = {
      name: "lang",
      value: "zh",
      domain: "site",
      path: "/dir",
      expires: null,
      secure: false,
      sameSite: "lax",
      partitioned: false,
    };
    expect(frame.send.mock.calls).toEqual(
      Array.from({ length: 2 }, () => [channels.changed, { documentId: "new", changed: [row], deleted: [] }]),
    );
    frame.send.mockClear();
    for (const cause of ["explicit", "expired", "evicted", "expired-overwrite"]) change(scoped, cause);
    const { value: _value, expires: _expires, ...deleted } = row;
    expect(frame.send.mock.calls).toEqual(
      Array.from({ length: 4 }, () => [channels.changed, { documentId: "new", changed: [], deleted: [deleted] }]),
    );
    expect(sibling.send).not.toHaveBeenCalled();
    frame.detached = true;
    sibling.origin = "null";
    change();
    frame.detached = false;
    sibling.origin = origin;
    change();
    expect(frame.send).toHaveBeenCalledTimes(4);
    expect(sibling.send).not.toHaveBeenCalled();
  });
});

describe("document.cookie outage handling", () => {
  it.each(["read", "write"] as const)(
    "bounds the first stalled %s, still issues probe writes and recovers on a successful write",
    async (first) => {
      vi.useFakeTimers();
      const { store, read, write, invoke } = setup();
      await write("lang=zh");
      expect(await read()).toBe("lang=zh");
      store.get.mockImplementationOnce(never);
      const asyncRequest = invoke(channels.getAll, url);
      if (first === "read") store.get.mockImplementationOnce(never);
      else store.set.mockImplementationOnce(never);
      const replied = vi.fn<(v: unknown) => void>();
      const blocked = (first === "read" ? read() : write("stalled=1")).then(replied);
      await vi.advanceTimersByTimeAsync(SYNC_STORE_TIMEOUT_MS - 1);
      expect(replied).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await blocked;
      expect(replied).toHaveBeenCalledWith(first === "read" ? "lang=zh" : "unknown");

      store.set.mockImplementationOnce(never);
      const probe = write("probe=1");
      expect(store.set).toHaveBeenLastCalledWith(expect.objectContaining({ name: "probe" }));
      await vi.advanceTimersByTimeAsync(SYNC_STORE_PROBE_TIMEOUT_MS);
      expect(await probe).toBe("unknown");

      await write("lang=en");
      store.get.mockImplementationOnce(never);
      const afterRecovery = vi.fn<(v: unknown) => void>();
      const full = read().then(afterRecovery);
      await vi.advanceTimersByTimeAsync(SYNC_STORE_TIMEOUT_MS - 1);
      expect(afterRecovery).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await full;
      expect(afterRecovery).toHaveBeenCalledWith("lang=zh");
      expect(await read()).toBe("lang=en");
      await vi.advanceTimersByTimeAsync(STORE_TIMEOUT_MS);
      expect(await asyncRequest).toMatchObject({ ok: false, error: { name: "TimeoutError" } });
      expect(await invoke(channels.getAll, url)).toMatchObject({ ok: true, value: [{ value: "en" }] });
    },
  );

  it("leaves cooldown on a successful protocol read, and ignores a stale timeout after recovery", async () => {
    vi.useFakeTimers();
    const { store, read, jar } = setup();
    store.get.mockImplementationOnce(never);
    const stalled = read();
    await vi.advanceTimersByTimeAsync(SYNC_STORE_TIMEOUT_MS);
    await stalled;
    store.get.mockImplementationOnce(never);
    const probing = read();
    await jar.cookieHeader({ path: "/", headers: new Headers() });
    await vi.advanceTimersByTimeAsync(SYNC_STORE_PROBE_TIMEOUT_MS);
    await probing;
    store.get.mockImplementationOnce(never);
    const replied = vi.fn<(reply: unknown) => void>();
    const full = read().then(replied);
    await vi.advanceTimersByTimeAsync(SYNC_STORE_TIMEOUT_MS - 1);
    expect(replied).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await full;
  });

  it("ends cooldown within five seconds even if the last failed probe straddles its end", async () => {
    vi.useFakeTimers();
    const { store, read } = setup();
    store.get.mockImplementation(never);
    const first = read();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toBe("");
    await vi.advanceTimersByTimeAsync(4975);
    const lastProbe = read();
    await vi.advanceTimersByTimeAsync(50);
    expect(await lastProbe).toBe("");
    const replied = vi.fn<(v: unknown) => void>();
    const full = read().then(replied);
    await vi.advanceTimersByTimeAsync(999);
    expect(replied).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await full;
  });

  it("times out structured writes without cancelling them or blocking later script calls", async () => {
    vi.useFakeTimers();
    const { store, invoke, read } = setup();
    store.set.mockImplementationOnce(never);
    const set = invoke(channels.storeSet, url, input);
    expect(await read()).toBe("");
    await vi.advanceTimersByTimeAsync(STORE_TIMEOUT_MS);
    expect(await set).toMatchObject({ ok: false, error: { name: "TimeoutError" } });
    expect(await invoke(channels.storeSet, url, input)).toMatchObject({ ok: true });
    expect(await read()).toBe("id=new");
  });

  it.each(["lang=en; Path=/", "lang=; Path=/; Max-Age=0", "lang=secret; Path=/; HttpOnly"])(
    "refreshes the fallback after a server update %s",
    async (header) => {
      vi.useFakeTimers();
      const { store, read, write, change, jar } = setup();
      await write("lang=zh; Path=/");
      expect(await read()).toBe("lang=zh");
      await jar.storeResponseCookies(new Headers({ "set-cookie": header }), { path: "/", headers: new Headers() });
      change({ ...note, httpOnly: header.includes("HttpOnly") });
      change(note, "inserted-no-change-overwrite");
      await vi.advanceTimersByTimeAsync(0);
      expect(store.get).toHaveBeenCalledTimes(2);
      store.get.mockImplementationOnce(never);
      const timedOut = read();
      await vi.advanceTimersByTimeAsync(SYNC_STORE_TIMEOUT_MS);
      expect(await timedOut).toBe(header.startsWith("lang=en") ? "lang=en" : "");
    },
  );

  it("keeps prior values during a stalled or failed refresh and coalesces changes received in flight", async () => {
    vi.useFakeTimers();
    const { store, read, write, change } = setup();
    await write("lang=zh");
    expect(await read()).toBe("lang=zh");
    store.get.mockImplementationOnce(never);
    change();
    await vi.advanceTimersByTimeAsync(0);
    change();
    change();
    store.get.mockRejectedValueOnce(new Error("store down"));
    expect(await read()).toBe("lang=zh");
    expect(store.get).toHaveBeenCalledTimes(3);
    store.get.mockRejectedValueOnce(new Error("refresh failed"));
    await vi.advanceTimersByTimeAsync(STORE_TIMEOUT_MS);
    expect(store.get).toHaveBeenCalledTimes(4);
    store.get.mockRejectedValueOnce(new Error("still down"));
    expect(await read()).toBe("lang=zh");
    await write("lang=en");
    change();
    await vi.advanceTimersByTimeAsync(0);
    store.get.mockRejectedValueOnce(new Error("read failed"));
    expect(await read()).toBe("lang=en");
  });

  it("uses a per-URL sequence so only the superseded background read is discarded", async () => {
    vi.useFakeTimers();
    const { store, read, write, change } = setup();
    const a = origin + "/a",
      b = origin + "/b";
    await write("lang=old; Path=/");
    expect(await read(a)).toBe("lang=old");
    expect(await read(b)).toBe("lang=old");
    let finishA!: (rows: Cookie[]) => void;
    let finishB!: (rows: Cookie[]) => void;
    store.get
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishA = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishB = resolve;
          }),
      );
    change();
    await vi.advanceTimersByTimeAsync(0);
    await write("lang=new; Path=/");
    expect(await read(a)).toBe("lang=new");
    finishA([{ ...note, value: "stale" }]);
    finishB([{ ...note, value: "refreshed" }]);
    await vi.advanceTimersByTimeAsync(0);
    store.get.mockImplementation(never);
    const fallback = Promise.all([read(a), read(b)]);
    await vi.advanceTimersByTimeAsync(SYNC_STORE_TIMEOUT_MS);
    expect(await fallback).toEqual(["lang=new", "lang=refreshed"]);
  });

  it("keeps at most one hundred snapshots, including recency of failed foreground reads", async () => {
    const { store, read, write } = setup();
    await write("x=1; Path=/");
    for (let i = 0; i < 100; i++) await read(origin + "/" + i);
    store.get.mockRejectedValueOnce(new Error("store down"));
    expect(await read(origin + "/0")).toBe("x=1");
    await read(origin + "/100");
    store.get.mockRejectedValue(new Error("store down"));
    expect(await read(origin + "/1")).toBe("");
    expect(await read(origin + "/0")).toBe("x=1");
  });
});
