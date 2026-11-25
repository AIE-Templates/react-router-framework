/* oxlint-disable typescript/unbound-method -- Capture native accessors and methods before application code runs. */
import type { Subscription, SubscriptionOperation } from "../shared.ts";

export interface SubscriptionBridge {
  acquire(scope: string, operation: SubscriptionOperation): Promise<{ operationId: string }>;
  complete(id: string, success: boolean): Promise<void>;
}

/** Serialized into both window and service worker main worlds. */
export function installSubscriptionShims(bridge: SubscriptionBridge): void {
  const { ServiceWorkerRegistration: Registration, CookieStoreManager: Manager, URL: NativeURL } = globalThis;
  if (!Registration || !Manager) return;
  const { defineProperty, getOwnPropertyDescriptor } = Object;
  const { apply } = Reflect;
  const { toWellFormed } = String.prototype;
  const scopes = new WeakMap<CookieStoreManager, string>();
  const registration = Registration.prototype;
  const cookies = getOwnPropertyDescriptor(registration, "cookies")!;
  const scope = getOwnPropertyDescriptor(registration, "scope")!.get!;
  const nativeUnregister = registration.unregister;
  defineProperty(registration, "cookies", {
    ...cookies,
    get(this: ServiceWorkerRegistration) {
      const manager: CookieStoreManager = apply(cookies.get!, this, []);
      scopes.set(manager, apply(scope, this, []));
      return manager;
    },
  });

  async function run<T>(target: string, operation: SubscriptionOperation, native: () => Promise<T>) {
    const { operationId } = await bridge.acquire(target, operation);
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
    Manager.prototype[kind] = async function (input) {
      const target = scopes.get(this);
      if (!target) throw new TypeError("Unknown CookieStoreManager receiver");
      // Snapshot the Web IDL sequence once, before the first await. Native and the
      // index must see identical entries even if input is a generator or has getters.
      if (!input || typeof input !== "object") throw new TypeError("Expected a sequence of cookie subscriptions");
      const subscriptions: Subscription[] = [];
      for (const entry of input) {
        if (entry != null && typeof entry !== "object" && typeof entry !== "function")
          throw new TypeError("Invalid subscription");
        const rawName = entry?.name;
        const name = rawName === undefined ? undefined : usv(rawName);
        const rawUrl = entry?.url;
        const url =
          rawUrl === undefined
            ? undefined
            : new NativeURL(usv(rawUrl), globalThis.document?.baseURI ?? globalThis.location.href).href;
        if (url !== undefined && !url.startsWith(target))
          throw new TypeError("Subscription URL must be within registration scope");
        subscriptions.push({ name, url });
      }
      await run(target, { kind, subscriptions }, () => apply(native, this, [subscriptions]));
    };
  }
}
