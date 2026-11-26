/// <reference lib="es2024.string" />
/* oxlint-disable typescript/unbound-method -- Primordials are captured deliberately and invoked with Reflect.apply. */
import type { CookieReply, CookieShimBridge, WindowCookie, WorkerStoreBridge } from "./types.ts";

/** Electron serializes this function; keep every runtime dependency inside it. */
export function installCookieShims(bridge: CookieShimBridge | WorkerStoreBridge): void {
  const realm = globalThis;
  const { apply, get } = Reflect;
  const NativeProxy = Proxy;
  const { defineProperty, getOwnPropertyDescriptor, getPrototypeOf } = Object;
  const { URL: NativeURL, TypeError: NativeTypeError, DOMException: NativeDOMException } = realm;
  const { options: installation } = bridge;

  if (installation.fetch) {
    const { Request: NativeRequest, Headers: NativeHeaders, fetch: nativeFetch } = realm;
    const reject = Promise.reject.bind(Promise);
    const getUrl = getOwnPropertyDescriptor(NativeRequest.prototype, "url")!.get!;
    const getCredentials = getOwnPropertyDescriptor(NativeRequest.prototype, "credentials")!.get!;
    const getHeaders = getOwnPropertyDescriptor(NativeRequest.prototype, "headers")!.get!;
    const getOrigin = getOwnPropertyDescriptor(NativeURL.prototype, "origin")!.get!;
    const { has, set, delete: remove } = NativeHeaders.prototype;
    const { appOrigin, markerHeader } = installation;

    realm.fetch = function fetch(this: unknown, input, init) {
      if (!arguments.length) return apply(nativeFetch, this, []);
      try {
        const req = new NativeRequest(input, init);
        const url = new NativeURL(apply(getUrl, req, []));
        if (apply(getOrigin, url, []) === appOrigin) {
          const headers: Headers = apply(getHeaders, req, []);
          if (apply(getCredentials, req, []) === "omit") {
            apply(set, headers, [markerHeader, "1"]);
          } else if (apply(has, headers, [markerHeader])) {
            apply(remove, headers, [markerHeader]);
          }
        }
        return apply(nativeFetch, this, [req]);
      } catch (error) {
        return reject(error);
      }
    };
  }

  if (!installation.cookieApi) return;

  const { creationUrl, appHost, documentId } = installation;
  const { getAll, set } = bridge;
  const windowBridge = "getCookie" in bridge ? bridge : undefined;
  const { document: ownDocument, Document, EventTarget: NativeEventTarget, CookieChangeEvent: ChangeEvent } = realm;
  const { addEventListener: add, dispatchEvent: dispatch } = NativeEventTarget.prototype;
  const getAborted = getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
  const getHref = getOwnPropertyDescriptor(NativeURL.prototype, "href")!.get!;
  const getPath = getOwnPropertyDescriptor(NativeURL.prototype, "pathname")!.get!;
  const setPath = getOwnPropertyDescriptor(NativeURL.prototype, "pathname")!.set!;
  const { startsWith, endsWith, includes, indexOf, lastIndexOf, slice, toLowerCase, replaceAll } = String.prototype;
  const { toWellFormed } = String.prototype;
  const { isFinite } = Number;
  const { trunc } = Math;
  const { now } = Date;
  const toBigInt = BigInt;
  const { asIntN } = BigInt;
  const toNumber = Number;
  const exec = RegExp.prototype.exec;
  const encoder = new TextEncoder();
  const encode = TextEncoder.prototype.encode;
  const parsedCreation = new NativeURL(creationUrl);
  const creationHref: string = apply(getHref, parsedCreation, []);
  const creationPath: string = apply(getPath, parsedCreation, []);
  // oxlint-disable-next-line no-control-regex -- Chromium rejects ASCII controls and semicolons in cookie data.
  const invalidData = /[;\x00-\x1f\x7f]/;
  const nonAscii = /[^\u0020-\u007e]/;
  const malformed = "Cookie was malformed and could not be stored, due to problem(s) while parsing.";

  // Only the registered singleton can use its lookup, even if page code copies the hook.
  const receiverMethodsKey = Symbol.for("@repo/electron-cookies/receiver-methods");
  function registerReceiver(owner: object, methods: object) {
    defineProperty(owner, receiverMethodsKey, {
      value: (receiver: unknown, method: string) =>
        receiver === owner ? getOwnPropertyDescriptor(methods, method)?.value : undefined,
    });
  }

  type Binding = (...args: never[]) => unknown;
  function invokeBorrowed(receiver: object, method: string, args: unknown[], original: Binding, brand: Binding) {
    let binding: unknown;
    try {
      // Use a native getter before inspecting the receiver, including for Proxy receivers.
      apply(brand, receiver, []);
      const lookup = getOwnPropertyDescriptor(receiver, receiverMethodsKey)?.value;
      if (typeof lookup === "function") binding = apply(lookup, undefined, [receiver, method]);
    } catch {
      // Let the original binding report its own receiver error.
    }
    return apply(typeof binding === "function" ? binding : original, receiver, args);
  }

  if (windowBridge) {
    const { getCookie, setCookie } = windowBridge;
    const cookie = getOwnPropertyDescriptor(Document.prototype, "cookie")!;
    const defaultView = getOwnPropertyDescriptor(Document.prototype, "defaultView")!.get!;
    defineProperty(Document.prototype, "cookie", {
      configurable: cookie.configurable,
      enumerable: cookie.enumerable,
      get(this: Document) {
        if (this !== ownDocument) return invokeBorrowed(this, "getCookie", [], cookie.get!, defaultView);
        const reply = getCookie(creationUrl);
        return typeof reply === "string" ? reply : "";
      },
      set(this: Document, value: unknown) {
        if (this !== ownDocument) {
          invokeBorrowed(this, "setCookie", [value], cookie.set!, defaultView);
          return;
        }
        setCookie(creationUrl, domString(value));
      },
    });
    const installed = getOwnPropertyDescriptor(Document.prototype, "cookie")!;
    registerReceiver(ownDocument, { getCookie: installed.get, setCookie: installed.set });
  }

  function withoutFragment(url: URL): string {
    const href: string = apply(getHref, url, []);
    const hash = apply(indexOf, href, ["#"]);
    return hash < 0 ? href : apply(slice, href, [0, hash]);
  }

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Serialized with the installer.
  function domString(input: unknown): string {
    // oxlint-disable-next-line typescript/restrict-template-expressions -- Web IDL ToString rejects Symbols and supplies the string hint.
    return `${input}`;
  }

  function usv(input: unknown): string {
    return apply(toWellFormed, domString(input), []);
  }

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Serialized with the installer.
  function isDictionary(input: unknown): input is Record<string, unknown> {
    return (typeof input === "object" && input !== null) || typeof input === "function";
  }

  function trimCookieText(text: string): string {
    // HTTP whitespace is only SP / HTAB; String#trim would also eat data such as NBSP.
    let first = 0;
    let last = text.length;
    while (first < last && (text[first] === " " || text[first] === "\t")) first++;
    while (last > first && (text[last - 1] === " " || text[last - 1] === "\t")) last--;
    return apply(slice, text, [first, last]);
  }

  type Operation = "get" | "getAll" | "set" | "delete";

  function fail(method: Operation, reason: string): never {
    throw new NativeTypeError(`Failed to execute '${method}' on 'CookieStore': ${reason}`);
  }

  function throwStoreError(method: Operation, error: { name: string; message: string }): never {
    if (error.name === "TypeError") fail(method, error.message);
    throw new NativeDOMException(error.message, error.name);
  }

  async function result<T>(method: Operation, invoke: () => Promise<CookieReply<T>>): Promise<T> {
    let reply: CookieReply<T>;
    try {
      reply = await invoke();
    } catch (error) {
      if (isDictionary(error) && typeof error.name === "string" && typeof error.message === "string") {
        throwStoreError(method, { name: error.name, message: error.message });
      }
      throw error;
    }
    if (!reply.ok) throwStoreError(method, reply.error);
    return reply.value;
  }

  async function read(method: "get" | "getAll", input: unknown) {
    let name: string | undefined;
    let url: string | undefined;
    if (isDictionary(input)) {
      const rawName = input.name;
      if (rawName !== undefined) name = usv(rawName);
      const rawUrl = input.url;
      if (rawUrl !== undefined) url = usv(rawUrl);
    } else if (input != null) {
      name = usv(input);
    }
    if (name === undefined && url === undefined && method === "get")
      fail(method, "CookieStoreGetOptions must not be empty");
    let readUrl = creationUrl;
    if (url !== undefined) {
      try {
        // Blink strips the resolved input fragment, then compares to the original cookie URL verbatim.
        readUrl = withoutFragment(new NativeURL(url, creationHref));
      } catch {
        return fail(
          method,
          windowBridge ? "URL must match the document URL" : "URL must be within Service Worker scope",
        );
      }
      if (windowBridge && readUrl !== creationHref) fail(method, "URL must match the document URL");
    }
    const filter = name === undefined ? undefined : trimCookieText(name);
    const rows = await result(method, () => getAll(readUrl, filter));
    // Values crossing contextBridge can be frozen. Return fresh, page-owned dictionaries.
    const cookies: WindowCookie[] = [];
    for (let i = 0; i < rows.length; i++) cookies[i] = { ...rows[i], partitioned: false };
    return cookies;
  }

  function normalizedPath(method: "set" | "delete", path: string, hostPrefix: boolean): string {
    if (!path) {
      const directory = apply(slice, creationPath, [0, apply(lastIndexOf, creationPath, ["/"])]) || "/";
      if (hostPrefix && directory !== "/") fail(method, malformed);
      // Chromium derives this path from the cookie URL, including directories invalid as explicit Path attributes.
      return "";
    }
    if (hostPrefix && path !== "/") fail(method, 'Cookies with "__Host-" prefix cannot have a non-"/" path');
    if (path[0] !== "/") fail(method, 'Cookie path must start with "/"');
    if (apply(exec, /[;\r\n\0]/, [path])) fail(method, malformed);
    // The pathname setter treats '?', '#', and leading '//' as path data. The
    // structured Chromium store also escapes pipes and embedded horizontal tabs.
    const url = new NativeURL(creationUrl);
    let pathname = apply(endsWith, path, ["/"]) ? path : `${path}/`;
    pathname = apply(replaceAll, pathname, ["|", "%7C"]);
    pathname = apply(replaceAll, pathname, ["\t", "%09"]);
    pathname = apply(replaceAll, pathname, ["\\", "/"]);
    apply(setPath, url, [pathname]);
    const canonical: string = apply(getPath, url, []);
    if (canonical.length > 1024) fail(method, malformed);
    return canonical;
  }

  function checkedWrite(method: "set" | "delete", options: Record<string, unknown>): WindowCookie {
    // Web IDL converts dictionary members in lexicographic order, each exactly once.
    const rawDomain = options.domain;
    const domain = rawDomain == null ? null : usv(rawDomain);
    const rawExpires = method === "set" ? options.expires : null;
    let expires = rawExpires == null ? null : +rawExpires;
    if (expires !== null && !isFinite(expires)) {
      fail(method, "Failed to read the 'expires' property from 'CookieInit': The provided double value is non-finite.");
    }
    const rawMaxAge = method === "set" ? options.maxAge : null;
    let maxAge: number | null = null;
    if (rawMaxAge != null) {
      const number = +rawMaxAge;
      maxAge = isFinite(number) ? toNumber(asIntN(64, toBigInt(trunc(number)))) : 0;
    }
    const rawName = options.name;
    if (rawName === undefined) {
      const dictionary = method === "set" ? "CookieInit" : "CookieStoreDeleteOptions";
      fail(method, `Failed to read the 'name' property from '${dictionary}': Required member is undefined.`);
    }
    const name = trimCookieText(usv(rawName));
    // Web IDL reads this member even though both partition choices map to one store.
    void options.partitioned;
    const rawPath = options.path;
    const path = rawPath === undefined ? "/" : usv(rawPath);
    const rawSite = method === "set" ? options.sameSite : undefined;
    const sameSite = rawSite === undefined ? "strict" : domString(rawSite);
    if (sameSite !== "strict" && sameSite !== "lax" && sameSite !== "none") {
      fail(
        method,
        `Failed to read the 'sameSite' property from 'CookieInit': The provided value '${sameSite}' is not a valid enum value of type CookieSameSite.`,
      );
    }
    // Delete is an expired structured write; the empty-name case needs a nonempty value.
    const rawValue = method === "delete" ? (name ? "" : "deleted") : options.value;
    if (rawValue === undefined)
      fail(method, "Failed to read the 'value' property from 'CookieInit': Required member is undefined.");
    const value = trimCookieText(usv(rawValue));
    if (!name && apply(includes, value, ["="])) fail(method, "Cookie value cannot contain '=' if the name is empty");
    if (!name && !value) fail(method, "Cookie name and value both cannot be empty");
    if (apply(includes, name, ["="])) fail(method, "Cookie name cannot contain '='");
    if (maxAge !== null) {
      if (expires !== null) fail(method, "Cookie expires and maxAge cannot both be specified");
      expires = maxAge <= 0 ? 0 : now() + maxAge * 1000;
    }

    const lower = apply(toLowerCase, name, []);
    const httpPrefix = apply(startsWith, lower, ["__http-"]);
    if (httpPrefix || apply(startsWith, lower, ["__host-http-"])) {
      fail(
        method,
        `Cookies with "${httpPrefix ? "__Http-" : "__Host-Http-"}" prefix cannot be set using the CookieStore API.`,
      );
    }
    const hostPrefix = apply(startsWith, lower, ["__host-"]);
    if (domain !== null) {
      if (hostPrefix) fail(method, 'Cookies with "__Host-" prefix cannot have a domain');
      if (domain[0] === ".") fail(method, 'Cookie domain cannot start with "."');
      if (apply(exec, nonAscii, [domain]) || apply(toLowerCase, domain, []) !== appHost) {
        fail(method, "Cookie domain must domain-match current host");
      }
    }
    const storedPath = normalizedPath(method, path, hostPrefix);
    if (
      apply(exec, invalidData, [name]) ||
      apply(exec, invalidData, [value]) ||
      (!name && apply(exec, /^__(?:secure|host|http)-/i, [value])) ||
      apply(encode, encoder, [name + value]).length > 4096
    )
      fail(method, malformed);

    return {
      name,
      value,
      path: storedPath,
      domain: domain === null ? null : appHost,
      expires: method === "delete" ? 0 : expires,
      sameSite,
      secure: true,
      partitioned: false,
    };
  }

  let registered = false;
  const store = realm.cookieStore;
  const prototype = realm.CookieStore.prototype;

  function listen() {
    if (registered) return;
    registered = true;
    try {
      windowBridge!.registerChanges(creationUrl, documentId, (push) => {
        if (push.documentId !== documentId) return;
        const event = new ChangeEvent("change", { changed: push.changed, deleted: push.deleted });
        apply(dispatch, store, [event]);
      });
    } catch (error) {
      registered = false;
      throw error;
    }
  }

  const methods = {
    async get(input?: unknown) {
      return (await read("get", input))[0] ?? null;
    },
    getAll(input?: unknown) {
      return read("getAll", input);
    },
    async set(input?: unknown, value?: unknown) {
      let options: Record<string, unknown>;
      if (arguments.length >= 2) options = { __proto__: null, name: usv(input), value: usv(value) };
      else if (isDictionary(input)) options = input;
      else if (!arguments.length) fail("set", "1 argument required, but only 0 present.");
      else fail("set", "The provided value is not of type 'CookieInit'.");
      const write = checkedWrite("set", options);
      await result("set", () => set(creationUrl, write));
    },
    async delete(input?: unknown) {
      if (!arguments.length) fail("delete", "1 argument required, but only 0 present.");
      const options = isDictionary(input) ? input : { __proto__: null, name: input == null ? undefined : usv(input) };
      const write = checkedWrite("delete", options);
      await result("delete", () => set(creationUrl, write));
    },
  };
  const storeBrand = windowBridge && getOwnPropertyDescriptor(prototype, "onchange")!.get!;
  // Keep the native singleton, constructor, global accessor and Web IDL receiver checks.
  for (const method of ["get", "getAll", "set", "delete"] as const) {
    const native = prototype[method];
    const invoke = methods[method];
    defineProperty(prototype, method, {
      ...getOwnPropertyDescriptor(prototype, method),
      value: new NativeProxy(native, {
        apply(original, receiver, args) {
          if (receiver === store) return apply(invoke, receiver, args);
          if (storeBrand) return invokeBorrowed(receiver, method, args, original, storeBrand);
          return apply(original, receiver, args);
        },
      }),
    });
  }
  if (windowBridge) {
    registerReceiver(store, {
      get: prototype.get,
      getAll: prototype.getAll,
      set: prototype.set,
      delete: prototype.delete,
    });
    const onchange = getOwnPropertyDescriptor(prototype, "onchange")!;
    const ownerKey = Symbol.for("@repo/electron-cookies/window-change-listener");
    const addListener = new NativeProxy(add, {
      apply(original, receiver, args) {
        if (args.length < 2 || args[1] == null || (typeof args[0] === "string" && args[0] !== "change")) {
          return apply(original, receiver, args);
        }
        if (receiver !== store) {
          // Register in the receiving window even when another window supplies the method.
          // Only a patched CookieStore setter can identify its owning singleton.
          const proto = receiver && typeof receiver === "object" && getPrototypeOf(receiver);
          const setter = proto && getOwnPropertyDescriptor(proto, "onchange")?.set;
          const lookup = setter && getOwnPropertyDescriptor(setter, ownerKey)?.value;
          const ownedAdd = typeof lookup === "function" ? apply(lookup, undefined, [receiver]) : undefined;
          return apply(typeof ownedAdd === "function" ? ownedAdd : original, receiver, args);
        }
        if (registered) return apply(original, receiver, args);
        const type = domString(args[0]);
        args[0] = type;
        if (type !== "change") return apply(original, receiver, args);
        const options: AddEventListenerOptions | boolean | undefined = args[2];
        // Let Web IDL validate the listener before reading options. Record the signal
        // used by the native call without reading any application getter twice.
        let signal: unknown;
        if (options !== null && (typeof options === "object" || typeof options === "function")) {
          args[2] = new NativeProxy(options, {
            get(target, key) {
              const value: unknown = get(target, key);
              if (key === "signal") signal = value;
              return value;
            },
          });
        }
        const added = apply(original, receiver, args);
        if (!signal || !apply(getAborted, signal, [])) listen();
        return added;
      },
    });
    defineProperty(prototype, "onchange", {
      ...onchange,
      set(this: CookieStore, value: unknown) {
        apply(onchange.set!, this, [value]);
        if (this === store && apply(onchange.get!, this, [])) listen();
      },
    });
    defineProperty(getOwnPropertyDescriptor(prototype, "onchange")!.set!, ownerKey, {
      value: (receiver: unknown) => (receiver === store ? addListener : undefined),
    });
    defineProperty(NativeEventTarget.prototype, "addEventListener", {
      ...getOwnPropertyDescriptor(NativeEventTarget.prototype, "addEventListener"),
      value: addListener,
    });
  }
}
