/* oxlint-disable typescript/unbound-method -- Capture native methods before the worker script runs. */
import type { WorkerCookieEvent, WorkerCookieItem } from "../shared.ts";

interface CookieWorkerGlobal extends EventTarget {
  registration: ServiceWorkerRegistration;
  serviceWorker: ServiceWorker;
  ExtendableCookieChangeEvent: new (name: string, init: CookieChangeEventInit) => Event;
}

export interface WorkerEventBridge {
  listen(deliver: (event: WorkerCookieEvent) => void, finish: (eventId: string) => void): void;
  started(eventId: string): void;
  ack(eventId: string): void;
  nack(eventId: string): void;
}

/** Serialized in the service worker. Nothing from the isolated world is exposed on self. */
export function installWorkerEvents(bridge: WorkerEventBridge): void {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This installer runs exclusively in a ServiceWorkerGlobalScope.
  const worker = self as unknown as CookieWorkerGlobal;
  const { registration, serviceWorker, ExtendableCookieChangeEvent: ChangeEvent } = worker;
  const { cookies, scope } = registration;
  const { getSubscriptions } = cookies;
  const { apply } = Reflect;
  const { defineProperty } = Object;
  const { dispatchEvent } = EventTarget.prototype;
  const { URL: NativeURL, DOMException: NativeDOMException } = globalThis;
  const resolve = Promise.resolve.bind(Promise);
  const { then } = Promise.prototype;
  const events = new Map<string, () => void>();

  async function deliver({ eventId, changed, deleted }: WorkerCookieEvent) {
    let dispatching = true;
    let pending = 0;
    let finished = false;
    function finish() {
      finished = true;
      events.delete(eventId);
    }
    function acknowledge() {
      if (!finished && !dispatching && pending === 0) {
        finish();
        bridge.ack(eventId);
      }
    }
    function settled() {
      pending--;
      acknowledge();
    }
    events.set(eventId, finish);
    try {
      if (registration.active !== serviceWorker) {
        finish();
        bridge.nack(eventId);
        return;
      }
      const subscriptions = await apply(getSubscriptions, cookies, []);
      if (finished) return; // Timed out while Chromium was reading subscriptions.
      if (registration.active !== serviceWorker) {
        finish();
        bridge.nack(eventId);
        return;
      }
      const matches = (item: WorkerCookieItem) =>
        subscriptions.some(({ name, url }) => {
          const path = new NativeURL(url ?? scope).pathname;
          return (
            (name === undefined || name === item.name) &&
            (path === item.path || path.startsWith(item.path.endsWith("/") ? item.path : item.path + "/"))
          );
        });
      const init = { changed: changed.filter(matches), deleted: deleted.filter(matches) };
      if (init.changed.length || init.deleted.length) {
        const event = new ChangeEvent("cookiechange", init);
        defineProperty(event, "waitUntil", {
          value(value: unknown) {
            if (finished) throw new NativeDOMException("Cookie change event has finished", "InvalidStateError");
            void apply(then, resolve(value), [settled, settled]);
            pending++;
          },
        });
        bridge.started(eventId);
        apply(dispatchEvent, worker, [event]);
      }
    } finally {
      dispatching = false;
      acknowledge();
    }
  }
  bridge.listen(
    (message) => {
      void deliver(message).catch((error: unknown) => globalThis.reportError(error));
    },
    (id) => events.get(id)?.(),
  );
}
