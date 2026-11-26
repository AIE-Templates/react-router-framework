// @vitest-environment jsdom
/* oxlint-disable typescript/unbound-method -- Receiver and invalid input are supplied explicitly to Reflect.apply. */
/* oxlint-disable unicorn/prefer-add-event-listener -- onchange itself is part of the contract under test. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { installCookieShims } from "./install-cookie-shims.ts";
import type { CookieInstallation, CookieShimBridge, WindowCookie } from "./types.ts";

const creationUrl = location.origin + "/catalog/page?q=1#initial";
const markerHeader = "x-desktop-cookie-omit";
const documentId = "first-document";
const sample: WindowCookie = {
  name: "a",
  value: "b",
  path: "/",
  domain: null,
  expires: null,
  secure: true,
  sameSite: "strict",
  partitioned: false,
};
const malformed = "Cookie was malformed and could not be stored, due to problem(s) while parsing.";

afterEach(() => document.body.replaceChildren());

// Native Web IDL getters accept branded instances from any window.
const handlers = new WeakMap<object, EventListener | null>();

function install(installation: CookieInstallation = { cookieApi: true, fetch: true, creationUrl }) {
  const frame = document.createElement("iframe");
  frame.src = installation.creationUrl ?? creationUrl;
  document.body.append(frame);
  const page = frame.contentWindow!.window;
  // jsdom supplies a fresh JS/DOM realm but has no Fetch or CookieChangeEvent bindings.
  class ChangeEvent extends page.Event {
    readonly changed;
    readonly deleted;
    constructor(type: string, init: CookieChangeEventInit) {
      super(type, init);
      this.changed = init.changed;
      this.deleted = init.deleted;
    }
  }
  const fetch = vi.fn<(this: unknown, req?: Request) => Promise<Response>>(function (this: unknown, req?: Request) {
    if (!req) return Promise.reject(new TypeError("missing request"));
    return Promise.resolve(new Response(null));
  });
  // Vitest wraps Node's Request in a subclass for Blob/FormData conversion.
  const nativeRequest: typeof Request = Object.hasOwn(Request.prototype, "url")
    ? Request
    : Object.getPrototypeOf(Request);
  Object.assign(page, { Request: nativeRequest, Headers, fetch, CookieChangeEvent: ChangeEvent });
  // jsdom has no CookieStore binding. Supply a stable native-shaped singleton
  // and exercise the original getter, its prototype, and the serialized patches.
  class NativeStore extends page.EventTarget {
    get onchange() {
      if (!handlers.has(this)) throw new TypeError("Illegal invocation");
      return handlers.get(this) ?? null;
    }
    set onchange(value: EventListener | null) {
      const previous = this.onchange;
      if (previous) this.removeEventListener("change", previous);
      handlers.set(this, value);
      if (value) this.addEventListener("change", value);
    }
    get() {
      if (!handlers.has(this)) throw new TypeError("Illegal invocation");
      return null;
    }
  }
  const native = NativeStore.prototype.get;
  Object.assign(NativeStore.prototype, { getAll: native, set: native, delete: native });
  const singleton = new NativeStore();
  handlers.set(singleton, null);
  const accessor = () => singleton;
  if (installation.cookieApi) {
    Object.defineProperty(page, "cookieStore", { configurable: true, get: accessor });
    Object.defineProperty(page, "CookieStore", { value: NativeStore });
  }
  const getAll = vi.fn<CookieShimBridge["getAll"]>().mockResolvedValue({ ok: true, value: [] });
  const set = vi.fn<CookieShimBridge["set"]>().mockResolvedValue({ ok: true, value: undefined });
  const bridge = {
    options: { ...installation, appOrigin: location.origin, appHost: location.hostname, markerHeader, documentId },
    getCookie: vi.fn<CookieShimBridge["getCookie"]>().mockReturnValue("a=b"),
    setCookie: vi.fn<CookieShimBridge["setCookie"]>(),
    getAll,
    set,
    registerChanges: vi.fn<CookieShimBridge["registerChanges"]>(),
  } satisfies CookieShimBridge;
  const source = Function.prototype.toString.call(installCookieShims);
  const run: typeof installCookieShims = page.eval(`(${source})`);
  const originalCookie = Object.getOwnPropertyDescriptor(page.Document.prototype, "cookie")!;
  run(bridge);
  return { page, bridge, fetch, originalCookie, accessor, store: page.cookieStore };
}

describe("serialized main-world cookie installer", () => {
  it("preserves the global accessor and routes branded prototype reads through the jar", async () => {
    const { page, bridge, accessor, store } = install();
    expect(Object.getOwnPropertyDescriptor(page, "cookieStore")?.get).toBe(accessor);
    expect(store).toBeInstanceOf(page.CookieStore);
    expect(store.constructor).toBe(page.CookieStore);
    bridge.getAll.mockResolvedValue({ ok: true, value: [sample] });
    expect(await page.CookieStore.prototype.get.call(store, { name: "a" })).toEqual(sample);
    expect(() => Reflect.apply(page.CookieStore.prototype.get, {}, ["a"])).toThrow("Illegal invocation");
    expect(bridge.getAll).toHaveBeenCalledExactlyOnceWith(creationUrl, "a");
  });

  it("DC-08/12/15/16 passes sync replies and DOMString assignments with the creation URL", () => {
    const { page, bridge } = install();
    const convert = vi.fn<(hint: string) => string>((hint: string) => hint + "=中文");
    bridge.setCookie.mockImplementationOnce((_url, text) => {
      bridge.getCookie.mockReturnValue(text);
    });
    page.history.pushState(null, "", "/later");
    Object.assign(page.document, { cookie: { [Symbol.toPrimitive]: convert } });
    expect(convert.mock.calls).toEqual([["string"]]);
    expect(bridge.setCookie.mock.calls).toEqual([[creationUrl, "string=中文"]]);
    expect(() => Object.assign(page.document, { cookie: Symbol() })).toThrow(page.TypeError);
    expect(bridge.setCookie).toHaveBeenCalledTimes(1);
    bridge.getCookie.mockReturnValueOnce(undefined);
    expect(page.document.cookie).toBe("");
    expect(page.document.cookie).toBe("string=中文");
    expect(bridge.getCookie.mock.calls).toEqual([[creationUrl], [creationUrl]]);
  });

  it("routes borrowed document accessors through the receiving document's creation URL", () => {
    const caller = install();
    const url = location.origin + "/owner/page";
    const owner = install({ cookieApi: true, fetch: true, creationUrl: url });
    owner.page.history.pushState({}, "", "/elsewhere");
    owner.bridge.getCookie.mockReturnValue("theme=blue");
    const cookie = Object.getOwnPropertyDescriptor(caller.page.Document.prototype, "cookie")!;
    expect(Reflect.apply(cookie.get!, owner.page.document, [])).toBe("theme=blue");
    expect(() => Reflect.apply(cookie.set!, owner.page.document, [Symbol()])).toThrow(caller.page.TypeError);
    const error = new owner.page.TypeError("conversion failed");
    const convert = vi.fn<(hint: string) => never>(() => {
      throw error;
    });
    let thrown: unknown;
    try {
      Reflect.apply(cookie.set!, owner.page.document, [{ [Symbol.toPrimitive]: convert }]);
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBe(error);
    expect(convert).toHaveBeenCalledExactlyOnceWith("string");
    Reflect.apply(cookie.set!, owner.page.document, ["theme=red"]);
    expect(owner.bridge.getCookie).toHaveBeenCalledExactlyOnceWith(url);
    expect(owner.bridge.setCookie).toHaveBeenCalledExactlyOnceWith(url, "theme=red");
    expect(caller.bridge.getCookie).not.toHaveBeenCalled();
    expect(caller.bridge.setCookie).not.toHaveBeenCalled();
  });

  it("routes all four borrowed CookieStore methods through the receiving store's creation URL", async () => {
    const caller = install();
    const url = location.origin + "/owner/page";
    const owner = install({ cookieApi: true, fetch: true, creationUrl: url });
    owner.page.history.pushState({}, "", "/elsewhere");
    owner.bridge.getAll.mockResolvedValue({ ok: true, value: [sample] });
    const proto = caller.page.CookieStore.prototype;
    expect(await proto.get.call(owner.store, { url, name: "a" })).toEqual(sample);
    expect(await proto.getAll.call(owner.store)).toEqual([sample]);
    await Reflect.apply(proto.set, owner.store, ["a", "b"]);
    await proto.delete.call(owner.store, { name: "a" });
    expect(owner.bridge.getAll.mock.calls).toEqual([
      [url, "a"],
      [url, undefined],
    ]);
    expect(owner.bridge.set.mock.calls).toEqual([
      [url, sample],
      [url, { ...sample, value: "", expires: 0 }],
    ]);
    expect(caller.bridge.getAll).not.toHaveBeenCalled();
    expect(caller.bridge.set).not.toHaveBeenCalled();
  });

  it("rejects borrowed CookieStore validation failures in the method realm", async () => {
    const caller = install();
    const owner = install();
    const proto = caller.page.CookieStore.prototype;
    for (const [method, args] of [
      ["get", []],
      ["getAll", [{ url: "/different" }]],
      ["set", [{ name: "a", value: "b", expires: Symbol() }]],
      ["delete", [{ name: "a", path: "relative" }]],
    ] as const) {
      const pending = Reflect.apply(proto[method], owner.store, args);
      expect(pending).toBeInstanceOf(caller.page.Promise);
      await expect(pending).rejects.toBeInstanceOf(caller.page.TypeError);
    }
    const conversionError = new owner.page.TypeError("getter failed");
    const name = vi.fn<() => never>(() => {
      throw conversionError;
    });
    const pending = proto.get.call(owner.store, Object.defineProperty({}, "name", { get: name }));
    await expect(pending).rejects.toBe(conversionError);
    expect(name).toHaveBeenCalledOnce();
    expect(owner.bridge.getAll).not.toHaveBeenCalled();
    expect(owner.bridge.set).not.toHaveBeenCalled();
  });

  it("uses receiver promises for borrowed store operations and rejects HttpOnly writes in the receiver realm", async () => {
    const caller = install();
    const owner = install();
    const proto = caller.page.CookieStore.prototype;
    owner.bridge.set.mockResolvedValueOnce({ ok: false, error: { name: "TypeError", message: malformed } });
    const denied = Reflect.apply(proto.set, owner.store, ["a", "b"]);
    expect(denied).toBeInstanceOf(owner.page.Promise);
    await expect(denied).rejects.toBeInstanceOf(owner.page.TypeError);
    await expect(denied).rejects.toMatchObject({ message: "Failed to execute 'set' on 'CookieStore': " + malformed });
    for (const error of [
      { name: "SecurityError", message: "Access to the CookieStore API is denied in this context." },
      { name: "TimeoutError", message: "Cookie store timed out" },
    ]) {
      owner.bridge.getAll.mockResolvedValueOnce({ ok: false, error });
      const pending = proto.getAll.call(owner.store);
      expect(pending).toBeInstanceOf(owner.page.Promise);
      await expect(pending).rejects.toBeInstanceOf(caller.page.DOMException);
      await expect(pending).rejects.toMatchObject(error);
    }
    owner.bridge.getAll.mockResolvedValue({ ok: true, value: [sample] });
    const read = proto.get.call(owner.store, { name: "a" });
    expect(read).toBeInstanceOf(owner.page.Promise);
    await expect(read).resolves.toEqual(sample);
    const write = Reflect.apply(proto.set, owner.store, ["a", "b"]);
    expect(write).toBeInstanceOf(owner.page.Promise);
    await expect(write).resolves.toBeUndefined();
    expect(caller.bridge.getAll).not.toHaveBeenCalled();
    expect(caller.bridge.set).not.toHaveBeenCalled();
  });

  it("keeps native bindings for unshimmed receivers and rejects lookalikes", () => {
    const caller = install();
    const native = install({ cookieApi: false, fetch: false, creationUrl: null });
    const key = Symbol.for("@repo/electron-cookies/receiver-methods");
    // Even a genuine lookup copied onto a branded native receiver cannot grant it jar access.
    Object.defineProperty(native.page.document, key, Object.getOwnPropertyDescriptor(caller.page.document, key)!);
    Object.defineProperty(native.accessor(), key, Object.getOwnPropertyDescriptor(caller.store, key)!);
    const cookie = Object.getOwnPropertyDescriptor(caller.page.Document.prototype, "cookie")!;
    try {
      Reflect.apply(cookie.set!, native.page.document, ["native=visible"]);
      expect(Reflect.apply(cookie.get!, native.page.document, [])).toBe("native=visible");
    } finally {
      native.page.document.cookie = "native=; Max-Age=0";
    }
    expect(Reflect.apply(caller.store.get, native.accessor(), ["a"])).toBeNull();
    const fake = Object.create(Object.getPrototypeOf(caller.store));
    for (const method of ["get", "getAll", "set", "delete"] as const) {
      expect(() => Reflect.apply(caller.store[method], fake, ["a"])).toThrow("Illegal invocation");
    }
    expect(() => Reflect.apply(cookie.set!, {}, ["a=b"])).toThrow(/Document/);
    expect(caller.bridge.getCookie).not.toHaveBeenCalled();
    expect(caller.bridge.setCookie).not.toHaveBeenCalled();
    expect(caller.bridge.getAll).not.toHaveBeenCalled();
    expect(caller.bridge.set).not.toHaveBeenCalled();
  });

  it("DC-11 delegates other documents and invalid receivers to the original accessors", () => {
    const { page, bridge, originalCookie } = install();
    for (const other of [
      page.document.implementation.createHTMLDocument(),
      new page.DOMParser().parseFromString("", "text/html"),
    ]) {
      other.cookie = "other=value";
      expect(other.cookie).toBe(Reflect.apply(originalCookie.get!, other, []));
    }
    const getter = Object.getOwnPropertyDescriptor(page.Document.prototype, "cookie")!.get!;
    expect(() => Reflect.apply(getter, {}, [])).toThrow(/Document/);
    expect(bridge.getCookie).not.toHaveBeenCalled();
    expect(bridge.setCookie).not.toHaveBeenCalled();
  });

  it("CS-01/02 reads exact names, keeps order and returns page-owned results", async () => {
    const { bridge, store, page } = install();
    bridge.getAll.mockResolvedValue({
      ok: true,
      value: [sample, { ...sample, value: "second", domain: location.hostname }],
    });
    const all = await store.getAll();
    expect(all).toEqual([sample, { ...sample, value: "second", domain: location.hostname }]);
    expect(all).toBeInstanceOf(page.Array);
    expect(all[0]).toBeInstanceOf(page.Object);
    all[0].value = "local";
    expect(await store.get({ name: "a" })).toEqual(sample);
    await store.getAll("a");
    bridge.getAll.mockResolvedValue({ ok: true, value: [] });
    expect(await store.get("absent")).toBeNull();
    expect(bridge.getAll.mock.calls.map(([, name]) => name)).toEqual([undefined, "a", "a", "absent"]);
    await expect(store.get({})).rejects.toThrow(page.TypeError);
  });

  it.each(["get", "getAll"] as const)(
    "DC-15/CS-03 resolves %s URLs against the creation URL after pushState",
    async (method) => {
      const url = location.origin + "/catalog/page?q=1";
      const { page, store, bridge } = install({ cookieApi: true, fetch: true, creationUrl: url });
      page.history.pushState(null, "", "/elsewhere/new?q=2");
      const accepted = ["", "#new", "?q=1#fragment", "page?q=1", "../catalog/page?q=1#fragment", url];
      for (const candidate of accepted) await store[method]({ url: candidate });
      for (const candidate of [page.location.href, "?q=2", "page", "page/?q=1", "new?q=2", "https://["]) {
        const rejected = store[method]({ url: candidate });
        await expect(rejected).rejects.toBeInstanceOf(page.TypeError);
        await expect(rejected).rejects.toMatchObject({
          message: `Failed to execute '${method}' on 'CookieStore': URL must match the document URL`,
        });
      }
      expect(bridge.getAll.mock.calls).toEqual(accepted.map(() => [url, undefined]));
    },
  );

  it("CS-03 keeps the original URL for implicit reads when the document loads with a fragment", async () => {
    const { store, bridge, page } = install();
    await store.getAll();
    for (const url of [creationUrl, "#new", "?q=1"]) {
      await expect(store.getAll({ url })).rejects.toBeInstanceOf(page.TypeError);
    }
    expect(bridge.getAll.mock.calls).toEqual([[creationUrl, undefined]]);
  });

  it.each(["/group;v=1", "/" + "a".repeat(1024)])(
    "preserves empty paths after pushState and rejects the same directory as an explicit path (case %#)",
    async (directory) => {
      const url = location.origin + directory + "/page";
      const { page, store, bridge } = install({ cookieApi: true, fetch: true, creationUrl: url });
      page.history.pushState(null, "", "/elsewhere/page");
      await store.set({ name: "a", value: "b", path: "" });
      await store.delete({ name: "a", path: "" });
      await expect(store.set({ name: "a", value: "b", path: directory })).rejects.toBeInstanceOf(page.TypeError);
      await expect(store.delete({ name: "a", path: directory })).rejects.toBeInstanceOf(page.TypeError);
      expect(bridge.set.mock.calls).toEqual([
        [url, { ...sample, path: "" }],
        [url, { ...sample, value: "", expires: 0, path: "" }],
      ]);
    },
  );

  it("CS-05/06/08/15 normalizes writes and expires the same identity for delete", async () => {
    const { store, bridge } = install();
    await store.set("a", "b");
    expect(bridge.set).toHaveBeenLastCalledWith(creationUrl, sample);
    const opts = {
      name: "a",
      value: "b",
      path: "/old/../目录 x",
      domain: location.hostname.toUpperCase(),
      expires: 2000.5,
      sameSite: "lax",
      secure: false,
      partitioned: true,
    } as const;
    await store.set(opts);
    const identity = { domain: location.hostname, path: "/%E7%9B%AE%E5%BD%95%20x/" };
    expect(bridge.set).toHaveBeenLastCalledWith(creationUrl, {
      ...sample,
      ...identity,
      expires: 2000.5,
      sameSite: "lax",
    });
    await store.delete(opts);
    expect(bridge.set).toHaveBeenLastCalledWith(creationUrl, { ...sample, ...identity, value: "", expires: 0 });
    await store.delete("");
    expect(bridge.set).toHaveBeenLastCalledWith(creationUrl, { ...sample, name: "", value: "deleted", expires: 0 });
    await store.set("__Host-id", "yes");
    expect(bridge.set).toHaveBeenLastCalledWith(creationUrl, { ...sample, name: "__Host-id", value: "yes" });
  });

  it.each([
    [{ name: "a=b", value: "v" }, "Cookie name cannot contain '='"],
    [{ name: "a", value: "v; Max-Age=0" }, malformed],
    [{ name: "", value: "a=b" }, "Cookie value cannot contain '=' if the name is empty"],
    [{ name: "", value: "" }, "Cookie name and value both cannot be empty"],
    [{ name: "", value: "__Secure-hidden" }, malformed],
    [{ name: "a\0b", value: "v" }, malformed],
    [{ name: "a", value: "v\tv" }, malformed],
    [{ name: "a", value: "中".repeat(1366) }, malformed],
    [
      { name: "__hOsT-id", value: "v", domain: location.hostname },
      'Cookies with "__Host-" prefix cannot have a domain',
    ],
    [{ name: "__Host-id", value: "v", path: "/sub" }, 'Cookies with "__Host-" prefix cannot have a non-"/" path'],
    [
      { name: "__Host-Http-id", value: "v" },
      'Cookies with "__Host-Http-" prefix cannot be set using the CookieStore API.',
    ],
    [{ name: "a", value: "v", domain: ".host" }, 'Cookie domain cannot start with "."'],
    [{ name: "a", value: "v", domain: "other.test" }, "Cookie domain must domain-match current host"],
    [{ name: "a", value: "v", path: "rel" }, 'Cookie path must start with "/"'],
    [{ name: "a", value: "v", path: "/" + "x".repeat(1023) }, malformed],
    [
      { name: "a", value: "v", expires: Infinity },
      "Failed to read the 'expires' property from 'CookieInit': The provided double value is non-finite.",
    ],
    [{ name: "a", value: "v", expires: 10, maxAge: 10 }, "Cookie expires and maxAge cannot both be specified"],
    [
      { name: "a", value: "v", sameSite: "INVALID" },
      "Failed to read the 'sameSite' property from 'CookieInit': The provided value 'INVALID' is not a valid enum value of type CookieSameSite.",
    ],
    [
      { name: "a", value: "v", sameSite: "bad\ud800" },
      "Failed to read the 'sameSite' property from 'CookieInit': The provided value 'bad\ud800' is not a valid enum value of type CookieSameSite.",
    ],
    [{ name: "a" }, "Failed to read the 'value' property from 'CookieInit': Required member is undefined."],
  ] as const)("CS-07 rejects invalid dictionary %# before IPC", async (input, message) => {
    const { page, store, bridge } = install();
    const pending = Reflect.apply(store.set, store, [input]);
    await expect(pending).rejects.toBeInstanceOf(page.TypeError);
    await expect(pending).rejects.toMatchObject({
      name: "TypeError",
      message: "Failed to execute 'set' on 'CookieStore': " + message,
    });
    expect(bridge.set).not.toHaveBeenCalled();
  });

  it("CS-05/07 performs Web IDL overload conversion once and counts UTF-8 bytes", async () => {
    const { store, page, bridge } = install();
    const convert = vi.fn<(hint: string) => string>(() => "\t a ");
    await Reflect.apply(store.set, store, [{ [Symbol.toPrimitive]: convert }, "中".repeat(1365)]);
    expect(convert.mock.calls).toEqual([["string"]]);
    expect(bridge.set.mock.calls[0][1].name).toBe("a");
    for (const args of [["a=b", "v"], ["a", "v; Max-Age=0"], [Symbol(), "v"], ["a"], []]) {
      await expect(Reflect.apply(store.set, store, args)).rejects.toBeInstanceOf(page.TypeError);
    }
    await expect(store.delete({ name: "a", domain: ".example" })).rejects.toBeInstanceOf(page.TypeError);
    expect(bridge.set).toHaveBeenCalledTimes(1);
  });

  it("CS-07 distinguishes a null set argument from an empty CookieInit dictionary", async () => {
    const { store, bridge } = install();
    for (const [input, reason] of [
      [null, "The provided value is not of type 'CookieInit'."],
      [{}, "Failed to read the 'name' property from 'CookieInit': Required member is undefined."],
    ] as const) {
      await expect(Reflect.apply(store.set, store, [input])).rejects.toMatchObject({
        name: "TypeError",
        message: "Failed to execute 'set' on 'CookieStore': " + reason,
      });
    }
    expect(bridge.set).not.toHaveBeenCalled();
  });

  it("CS-09/14 rebuilds structured errors in the page realm and recovers", async () => {
    const { page, bridge, store } = install();
    const failure = { name: "TypeError", message: malformed };
    for (const method of ["set", "delete"] as const) {
      bridge.set.mockResolvedValueOnce({ ok: false, error: failure });
      const denied = method === "set" ? store.set("http-only", "new") : store.delete("http-only");
      await expect(denied).rejects.toBeInstanceOf(page.TypeError);
      await expect(denied).rejects.toMatchObject({
        name: "TypeError",
        message: `Failed to execute '${method}' on 'CookieStore': ${malformed}`,
      });
    }
    const errors = [
      { name: "TimeoutError", message: "Cookie store timed out" },
      { name: "SecurityError", message: "Access to the CookieStore API is denied in this context." },
    ];
    for (const error of errors) {
      bridge.getAll.mockResolvedValueOnce({ ok: false, error });
      const read = store.getAll();
      await expect(read).rejects.toBeInstanceOf(page.DOMException);
      await expect(read).rejects.toMatchObject(error);
      bridge.set.mockResolvedValueOnce({ ok: false, error });
      const write = store.set("a", "b");
      await expect(write).rejects.toBeInstanceOf(page.DOMException);
      await expect(write).rejects.toMatchObject(error);
    }
    await expect(store.getAll()).resolves.toEqual([]);
    await expect(store.set("a", "b")).resolves.toBeUndefined();
  });

  it.each(["prototype", "borrowed"])("registers the first change listener through a %s method", (source) => {
    const { page, bridge, store } = install();
    const add = source === "prototype" ? page.EventTarget.prototype.addEventListener : page.document.addEventListener;
    const listener = vi.fn<() => void>();
    add.call(page.document, "change", listener);
    expect(bridge.registerChanges).not.toHaveBeenCalled();
    add.call(store, "change", listener);
    expect(bridge.registerChanges).toHaveBeenCalledExactlyOnceWith(creationUrl, documentId, expect.any(Function));
    expect(Object.hasOwn(page.CookieStore.prototype, "addEventListener")).toBe(false);
    const [, , receive] = bridge.registerChanges.mock.calls[0];
    receive({ documentId, changed: [sample], deleted: [] });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("registers the receiver when addEventListener is borrowed from another installed window", () => {
    const caller = install();
    const owner = install();
    const listener = vi.fn<() => void>();
    caller.page.document.addEventListener.call(owner.store, "change", listener);
    expect(owner.bridge.registerChanges).toHaveBeenCalledOnce();
    expect(caller.bridge.registerChanges).not.toHaveBeenCalled();
    owner.bridge.registerChanges.mock.calls[0][2]({ documentId, changed: [sample], deleted: [] });
    expect(listener).toHaveBeenCalledOnce();
  });

  it.each(["onchange", "addEventListener"])(
    "CS-11/13 registers once via %s and drops stale document pushes",
    (first) => {
      const { page, bridge, store } = install();
      const one = vi.fn<(event: CookieChangeEvent) => void>();
      const two = vi.fn<(event: CookieChangeEvent) => void>();
      Reflect.apply(store.addEventListener, store, ["anything", one]);
      Reflect.apply(store.addEventListener, store, ["change", null]);
      const controller = new page.AbortController();
      controller.abort();
      store.addEventListener("change", two, { signal: controller.signal });
      expect(bridge.registerChanges).not.toHaveBeenCalled();
      if (first === "onchange") store.onchange = one;
      store.addEventListener("change", two);
      store.onchange = one;
      expect(bridge.registerChanges).toHaveBeenCalledTimes(1);
      const [url, id, receive] = bridge.registerChanges.mock.calls[0];
      expect([url, id]).toEqual([creationUrl, documentId]);
      receive({ documentId: "old", changed: [sample], deleted: [] });
      expect(one).not.toHaveBeenCalled();
      expect(two).not.toHaveBeenCalled();
      receive({ documentId, changed: [sample], deleted: [] });
      const event = one.mock.calls[0][0];
      expect(event).toBeInstanceOf(page.CookieChangeEvent);
      expect(event.target).toBe(store);
      expect(event.changed).toEqual([sample]);
      expect(two).toHaveBeenCalledWith(event);
      const deleted = {
        name: sample.name,
        domain: null,
        path: "/",
        sameSite: "strict",
        secure: true,
        partitioned: false,
      } as const;
      receive({ documentId, changed: [], deleted: [deleted] });
      expect(one.mock.calls[1][0].deleted[0]).toEqual(deleted);
      store.onchange = null;
      store.removeEventListener("change", two);
      receive({ documentId, changed: [], deleted: [deleted] });
      expect(one).toHaveBeenCalledTimes(2);
      expect(two).toHaveBeenCalledTimes(2);
    },
  );
});

describe("serialized fetch wrapper", () => {
  it("DC-25/E uses the captured constructors, getters and header methods after installation", async () => {
    const { page, fetch } = install();
    const credentials = vi.spyOn(page.Request.prototype, "credentials", "get").mockImplementation(() => "include");
    const set = vi.spyOn(page.Headers.prototype, "set").mockImplementation(() => {
      throw new Error("patched");
    });
    try {
      Object.defineProperty(page, "Request", {
        value: vi.fn<() => never>(() => {
          throw new Error("patched");
        }),
      });
      await page.fetch(creationUrl, { credentials: "omit" });
      expect(fetch.mock.calls[0][0]!.headers.get(markerHeader)).toBe("1");
      expect(credentials).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
    } finally {
      set.mockRestore();
      credentials.mockRestore();
    }
  });
  it("DC-25 rejects the original throwing getter exactly once without fetching", async () => {
    const { page, fetch } = install();
    const error = new Error("first read fails");
    const getter = vi
      .fn<() => string>()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockReturnValue("GET");
    const init = Object.defineProperty({}, "method", { get: getter });
    await expect(page.fetch(creationUrl, init)).rejects.toBe(error);
    expect(getter).toHaveBeenCalledTimes(1);
    await expect(page.fetch("https://[")).rejects.toThrow(TypeError);
    await expect(page.fetch(creationUrl, { method: "GET", body: "invalid" })).rejects.toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
    await expect(Reflect.apply(page.fetch, page, [])).rejects.toThrow(TypeError);
    expect(fetch.mock.calls).toEqual([[]]);
  });

  it("DC-25/SRV-07 uses internal request slots, cleans stale markers and preserves this", async () => {
    const { page, fetch } = install();
    const req = new Request(creationUrl, { credentials: "omit" });
    const overridden = vi.fn<() => never>(() => {
      throw new Error("instance getter");
    });
    Object.defineProperties(req, { credentials: { get: overridden }, url: { get: overridden } });
    const receiver = {};
    await Reflect.apply(page.fetch, receiver, [req]);
    expect(req.headers.has(markerHeader)).toBe(false);
    const marked = fetch.mock.calls[0][0]!;
    expect(marked.headers.get(markerHeader)).toBe("1");
    expect(fetch.mock.contexts[0]).toBe(receiver);
    expect(overridden).not.toHaveBeenCalled();
    await page.fetch(marked, { credentials: "include" });
    expect(fetch.mock.calls[1][0]!.headers.has(markerHeader)).toBe(false);
    expect(marked.headers.get(markerHeader)).toBe("1");
    const remoteUrl = "https://elsewhere.test/api";
    await page.fetch(remoteUrl, { credentials: "omit" });
    expect(fetch.mock.calls[2][0]!.headers.has(markerHeader)).toBe(false);
    await page.fetch(remoteUrl, { headers: { [markerHeader]: "caller" } });
    expect(fetch.mock.calls[3][0]!.headers.get(markerHeader)).toBe("caller");
  });

  it("DC-21/25 a fetch-only installation leaves cookie APIs alone and rejects a blob-relative URL", async () => {
    const { page, fetch, bridge } = install({ cookieApi: false, fetch: true, creationUrl: null });
    expect(page.cookieStore).toBeUndefined();
    expect(page.document.cookie).toBe("");
    expect(bridge.getCookie).not.toHaveBeenCalled();
    await expect(page.fetch("relative")).rejects.toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
    await page.fetch(creationUrl, { credentials: "omit" });
    expect(fetch.mock.calls[0][0]!.headers.has(markerHeader)).toBe(true);
  });
});
