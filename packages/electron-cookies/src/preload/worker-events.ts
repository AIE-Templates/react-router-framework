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
  const { defineProperty, getOwnPropertyDescriptor } = Object;
  const { dispatchEvent } = EventTarget.prototype;
  const { URL: NativeURL, DOMException: NativeDOMException } = globalThis;
  const pathname = getOwnPropertyDescriptor(NativeURL.prototype, "pathname")!.get!;
  const active = getOwnPropertyDescriptor(ServiceWorkerRegistration.prototype, "active")!.get!;
  const { startsWith, endsWith } = String.prototype;
  const { some, filter } = Array.prototype;
  const report = globalThis.reportError.bind(globalThis);
  const enqueueMicrotask = globalThis.queueMicrotask.bind(globalThis);
  const resolve = Promise.resolve.bind(Promise);
  const { then } = Promise.prototype;
  const events = new Map<string, () => void>();

  const track = events.set.bind(events);
  const lookup = events.get.bind(events);
  const forget = events.delete.bind(events);

  async function deliver({ eventId, changed, deleted }: WorkerCookieEvent) {
    let dispatching = true;
    let pending = 0;
    let started = false;
    let finished = false;
    function finish() {
      finished = true;
      forget(eventId);
    }
    function acknowledge() {
      if (!finished && !dispatching && pending === 0) {
        finish();
        bridge.ack(eventId);
      }
    }
    function settled() {
      // Other reactions to this promise may add another lifetime promise before the decrement.
      enqueueMicrotask(() => {
        pending--;
        acknowledge();
      });
    }
    track(eventId, finish);
    try {
      if (apply(active, registration, []) !== serviceWorker) {
        finish();
        bridge.nack(eventId);
        return;
      }
      const subscriptions = await apply(getSubscriptions, cookies, []);
      if (finished) return; // Timed out while Chromium was reading subscriptions.
      if (apply(active, registration, []) !== serviceWorker) {
        finish();
        bridge.nack(eventId);
        return;
      }
      const matches = (item: WorkerCookieItem) =>
        apply(some, subscriptions, [
          ({ name, url }: CookieStoreGetOptions) => {
            const path: string = apply(pathname, new NativeURL(url ?? scope), []);
            return (
              (name === undefined || name === item.name) &&
              (path === item.path ||
                apply(startsWith, path, [apply(endsWith, item.path, ["/"]) ? item.path : item.path + "/"]))
            );
          },
        ]);
      const init = { changed: apply(filter, changed, [matches]), deleted: apply(filter, deleted, [matches]) };
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
        started = true;
        apply(dispatchEvent, worker, [event]);
      }
    } catch (error) {
      if (!started && !finished) {
        finish();
        bridge.nack(eventId);
      }
      throw error;
    } finally {
      dispatching = false;
      acknowledge();
    }
  }
  bridge.listen(
    (message) => {
      void apply(then, deliver(message), [undefined, report]);
    },
    (id) => lookup(id)?.(),
  );
}
