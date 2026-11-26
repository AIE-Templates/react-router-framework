/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

export type WorkerCommand = { record?: boolean } & (
  | {
      kind:
        | "startup"
        | "events"
        | "append"
        | "append-on-settlement"
        | "release-first"
        | "release-last"
        | "late"
        | "identity"
        | "property-events";
    }
  | { kind: "subscriptions" | "subscribe" | "unsubscribe"; name?: string; entries?: CookieStoreGetOptions[] }
  | { kind: "get"; name: string }
  | { kind: "set"; name: string; value: string }
  | { kind: "read-url"; method: "get" | "getAll"; url: string }
  | { kind: "write-url"; method: "set" | "delete"; name: string; path?: string; url: string }
  | { kind: "fetch"; url: string; credentials: RequestCredentials }
);

export type ObservedCookie = CookieListItem & { domain?: string | null; expires?: number | null };

export interface WorkerChange {
  changed: ObservedCookie[];
  deleted: ObservedCookie[];
  version: string;
  boot: string;
  instance: boolean;
  trusted: boolean;
}

const version = new URL(self.location.href).searchParams.get("version") ?? "A";
const boot = crypto.randomUUID();
// Capture and use the API during script evaluation, before install, activate or a message.
const startup = self.cookieStore.getAll("visibility").then(
  (visible) => ({ visible, nativeStore: self.cookieStore instanceof CookieStore }),
  (error: unknown) => ({ error: String(error) }),
);
const channel = new BroadcastChannel("fixture-cookie-changes");
const events: WorkerChange[] = [];
const propertyEvents: CookieListItem["name"][] = [];
// oxlint-disable-next-line unicorn/prefer-add-event-listener -- Exercise the global event-handler attribute.
self.oncookiechange = (event) => {
  propertyEvents.push(...event.changed.map((cookie) => cookie.name), ...event.deleted.map((cookie) => cookie.name));
};
let held: ExtendableCookieChangeEvent | undefined;
let firstLifetime: Promise<void> | undefined;
let releaseFirst: (() => void) | undefined;
let releaseLast: (() => void) | undefined;
self.addEventListener("cookiechange", (event) => {
  const first = event.changed[0]?.name;
  if (first === "held" || first === "A") {
    held = event;
    firstLifetime = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    event.waitUntil(firstLifetime);
  }
  if (first === "B") releaseFirst?.();
  const change: WorkerChange = {
    changed: event.changed.map((cookie) => ({ ...cookie })),
    deleted: event.deleted.map((cookie) => ({ ...cookie })),
    version,
    boot,
    instance: event instanceof ExtendableCookieChangeEvent,
    trusted: event.isTrusted,
  };
  events.push(change);
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel is origin-scoped.
  channel.postMessage(change);
});

function descriptor(target: object) {
  const d = Object.getOwnPropertyDescriptor(target, "cookieStore");
  return (
    d && {
      enumerable: d.enumerable,
      configurable: d.configurable,
      get: d.get?.name,
      set: d.set?.name,
      writable: d.writable,
    }
  );
}

async function run(command: WorkerCommand) {
  const { cookies } = self.registration;
  switch (command.kind) {
    case "startup":
      return startup;
    case "events":
      return events;
    case "property-events":
      return propertyEvents;
    case "identity": {
      return {
        type: typeof CookieStore,
        constructor: self.cookieStore.constructor.name,
        sameConstructor: self.cookieStore.constructor === CookieStore,
        instance: self.cookieStore instanceof CookieStore,
        prototype: Object.getPrototypeOf(self.cookieStore) === CookieStore.prototype,
        tag: Object.prototype.toString.call(self.cookieStore),
        global: descriptor(self),
        inherited: descriptor(ServiceWorkerGlobalScope.prototype),
        read: await CookieStore.prototype.get.call(self.cookieStore, { name: "identity" }),
      };
    }
    case "read-url":
      return self.cookieStore[command.method]({ name: "visibility", url: command.url });
    case "write-url": {
      // url is an unknown dictionary member on writes. Send it unchanged to both engines.
      const options = { name: command.name, value: "written", path: command.path, url: command.url };
      return self.cookieStore[command.method](options);
    }
    case "get":
      return self.cookieStore.get(command.name);
    case "set":
      return self.cookieStore.set(command.name, command.value);
    case "fetch": {
      const response = await fetch(command.url, { credentials: command.credentials });
      return { status: response.status, body: await response.text() };
    }
    case "subscribe":
    case "unsubscribe":
      await cookies[command.kind](command.entries ?? [{ name: command.name }]);
      return cookies.getSubscriptions();
    case "subscriptions":
      return cookies.getSubscriptions();
    case "append":
    case "append-on-settlement": {
      if (!held || !firstLifetime || !releaseFirst) throw new Error("Missing held event");
      const event = held;
      const append = () =>
        event.waitUntil(
          new Promise<void>((resolve) => {
            releaseLast = resolve;
          }),
        );
      if (command.kind === "append-on-settlement") {
        const result = firstLifetime.then(append);
        releaseFirst();
        return result;
      }
      append();
      return;
    }
    case "release-first":
      return releaseFirst?.();
    case "release-last":
      return releaseLast?.();
    case "late": {
      if (!held) throw new Error("Missing held event");
      try {
        held.waitUntil(Promise.resolve());
        return "accepted";
      } catch (error) {
        if (!(error instanceof DOMException)) throw error;
        return error.name;
      }
    }
  }
}

self.addEventListener("message", (event: ExtendableMessageEvent & { data: WorkerCommand }) => {
  const port = event.ports[0];
  event.waitUntil(
    run(event.data).then(
      (value) => port.postMessage({ value }),
      (error: unknown) => {
        if (event.data.record && error instanceof Error) {
          port.postMessage({ value: { error: { name: error.name, message: error.message } } });
        } else {
          port.postMessage({ error: String(error) });
        }
      },
    ),
  );
});
self.addEventListener("fetch", (event) => {
  if (new URL(event.request.url).pathname !== "/reissue") return;
  event.respondWith(
    (async () => {
      const response = await fetch(event.request, { credentials: "include" });
      const headers = new Headers(response.headers);
      headers.set("x-fixture-original-credentials", event.request.credentials);
      headers.set("x-fixture-original-marker", event.request.headers.get("x-desktop-omit-cookies") ?? "absent");
      return new Response(response.body, { status: response.status, headers });
    })(),
  );
});
