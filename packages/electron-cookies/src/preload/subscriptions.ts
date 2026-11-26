/* oxlint-disable typescript/unbound-method -- Capture native accessors and methods before application code runs. */
import type { Subscription, SubscriptionOperation } from "../shared.ts";

export interface SubscriptionBridge {
  acquire(scope: string, operation: SubscriptionOperation): Promise<{ operationId: string }>;
  complete(id: string, success: boolean): Promise<void>;
}

/** Serialized into both window and service worker main worlds. */
export function installSubscriptionShims(bridge: SubscriptionBridge): void {
  const {
    ServiceWorkerRegistration: Registration,
    CookieStoreManager: Manager,
    URL: NativeURL,
    TypeError: NativeTypeError,
  } = globalThis;
  if (!Registration || !Manager) return;
  const { defineProperty, getOwnPropertyDescriptor, getPrototypeOf } = Object;
  const { apply } = Reflect;
  const { toWellFormed } = String.prototype;
  const { startsWith, indexOf, slice } = String.prototype;
  const { canParse } = NativeURL;
  const href = getOwnPropertyDescriptor(NativeURL.prototype, "href")!.get!;
  const registrations = new WeakMap<CookieStoreManager, ServiceWorkerRegistration>();
  const remember = registrations.set.bind(registrations);
  const lookup = registrations.get.bind(registrations);
  const lookupKey = Symbol.for("@repo/electron-cookies/lookup-registration");
  const registration = Registration.prototype;
  const cookies = getOwnPropertyDescriptor(registration, "cookies")!;
  const scope = getOwnPropertyDescriptor(registration, "scope")!.get!;
  const nativeUnregister = registration.unregister;
  defineProperty(registration, "cookies", {
    ...cookies,
    get(this: ServiceWorkerRegistration) {
      const manager: CookieStoreManager = apply(cookies.get!, this, []);
      remember(manager, this);
      return manager;
    },
  });

  async function run<T>(target: string, operation: SubscriptionOperation, native: () => Promise<T>) {
    let operationId: string;
    try {
      ({ operationId } = await bridge.acquire(target, operation));
    } catch (error) {
      // Electron wraps errors from ipcMain.handle and only preserves their message.
      const message = error && typeof error === "object" && "message" in error && error.message;
      if (typeof message === "string") {
        const offset: number = apply(indexOf, message, ["Cookie subscription limit exceeded: "]);
        if (offset >= 0) throw new NativeTypeError(apply(slice, message, [offset]));
      }
      throw error;
    }
    let success = false;
    try {
      const value = await native();
      success = value !== false;
      return value;
    } finally {
      await bridge.complete(operationId, success);
    }
  }
  registration.unregister = async function unregister() {
    const target: string = apply(scope, this, []);
    return run(target, { kind: "unregister" }, () => apply(nativeUnregister, this, []));
  };
  function usv(value: unknown): string {
    // oxlint-disable-next-line typescript/restrict-template-expressions -- Web IDL uses ToString (including rejection of Symbols).
    return apply(toWellFormed, `${value}`, []);
  }
  for (const kind of ["subscribe", "unsubscribe"] as const) {
    const native = Manager.prototype[kind];
    const wrapped = async function (this: CookieStoreManager, input: CookieStoreGetOptions[]) {
      const owner = lookup(this);
      if (!owner) {
        // A borrowed method can receive a manager from another installation. Only
        // its own registration knows the scope and owns its subscription bridge.
        const proto: object | null = this && getPrototypeOf(this);
        const method = proto && getOwnPropertyDescriptor(proto, kind)?.value;
        const foreignLookup = method && getOwnPropertyDescriptor(method, lookupKey)?.value;
        const foreignOwner = foreignLookup && apply(foreignLookup, undefined, [this]);
        if (foreignOwner && apply(cookies.get!, foreignOwner, []) === this) return apply(method, this, arguments);
        // Unwrapped realms and invalid receivers retain native Web IDL behavior.
        return apply(native, this, arguments);
      }
      const target: string = apply(scope, owner, []);
      // Snapshot the Web IDL sequence once, before the first await. Native and the
      // index must see identical entries even if input is a generator or has getters.
      if (!input || (typeof input !== "object" && typeof input !== "function"))
        throw new NativeTypeError("Expected a sequence of cookie subscriptions");
      const subscriptions: Subscription[] = [];
      for (const entry of input) {
        if (entry != null && typeof entry !== "object" && typeof entry !== "function")
          throw new NativeTypeError("Invalid subscription");
        const rawName = entry?.name;
        const name = rawName === undefined ? undefined : usv(rawName);
        const rawUrl = entry?.url;
        let url: string | undefined;
        if (rawUrl !== undefined) {
          const text = usv(rawUrl);
          if (canParse(text, target)) url = apply(href, new NativeURL(text, target), []);
          if (!url || !apply(startsWith, url, [target]))
            throw new NativeTypeError(
              `Failed to execute '${kind}' on 'CookieStoreManager': URL must be within ServiceWorker scope`,
            );
        }
        subscriptions[subscriptions.length] = { name, url };
      }
      return run(target, { kind, subscriptions }, () => apply(native, this, [subscriptions]));
    };
    defineProperty(wrapped, lookupKey, { value: lookup });
    Manager.prototype[kind] = wrapped;
  }
}
