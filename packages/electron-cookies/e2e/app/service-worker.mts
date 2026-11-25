/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

export type WorkerCommand =
  | { kind: "startup" | "events" | "append" | "release-first" | "release-last" | "late" }
  | { kind: "subscriptions" | "subscribe" | "unsubscribe"; name?: string }
  | { kind: "get"; name: string }
  | { kind: "set"; name: string; value: string }
  | { kind: "fetch"; url: string; credentials: RequestCredentials };

export interface WorkerChange {
  changed: CookieListItem[];
  deleted: CookieListItem[];
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
let held: ExtendableCookieChangeEvent | undefined;
let releaseFirst: (() => void) | undefined;
let releaseLast: (() => void) | undefined;
self.addEventListener("cookiechange", (event) => {
  const first = event.changed[0]?.name;
  if (first === "held" || first === "A") {
    held = event;
    event.waitUntil(
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
    );
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

async function run(command: WorkerCommand) {
  const { cookies } = self.registration;
  switch (command.kind) {
    case "startup":
      return startup;
    case "events":
      return events;
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
      await cookies[command.kind]([{ name: command.name }]);
      return cookies.getSubscriptions();
    case "subscriptions":
      return cookies.getSubscriptions();
    case "append": {
      if (!held) throw new Error("Missing held event");
      held.waitUntil(
        new Promise<void>((resolve) => {
          releaseLast = resolve;
        }),
      );
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
      (error: unknown) => port.postMessage({ error: String(error) }),
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
