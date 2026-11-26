import type { BrowserContext, Page } from "@playwright/test";

import type { WorkerChange, WorkerCommand } from "./app/service-worker.mts";
import { expect, type Fixture } from "./fixture.ts";

export const scope = "/area/";
export const script = "/scripts/service-worker.js";

declare global {
  interface Window {
    swChanges: WorkerChange[];
  }
}

export async function observe(page: Page) {
  await page.evaluate(() => {
    window.swChanges = [];
    const channel = new BroadcastChannel("fixture-cookie-changes");
    channel.addEventListener("message", (event: MessageEvent<WorkerChange>) => window.swChanges.push(event.data));
  });
}

export function register(
  page: Page,
  versionName = "A",
  registrationSlot: "active" | "waiting" = "active",
  registrationScope = scope,
) {
  return page.evaluate(
    async ({ scriptUrl, target, slot, version }) => {
      const url = new URL(scriptUrl, location.href);
      if (version) url.searchParams.set("version", version);
      const reg = await navigator.serviceWorker.register(url, {
        scope: target,
        type: "module",
        updateViaCache: "none",
      });
      const worker = [reg.installing, reg.waiting, reg.active].find((entry) => entry?.scriptURL === url.href);
      if (!worker) throw new Error("Missing registered version " + version);
      const state = slot === "waiting" ? "installed" : "activated";
      await new Promise<void>((resolve, reject) => {
        const check = () => {
          if (worker.state === state) resolve();
          else if (worker.state === "redundant") reject(new Error("Worker became redundant: " + url.href));
          else return;
          worker.removeEventListener("statechange", check);
        };
        worker.addEventListener("statechange", check);
        check();
      });
      return { scope: reg.scope, script: worker.scriptURL, state: worker.state };
    },
    { scriptUrl: script, target: registrationScope, slot: registrationSlot, version: versionName },
  );
}

export function command(
  page: Page,
  request: WorkerCommand,
  registrationSlot: "active" | "waiting" = "active",
  registrationScope = scope,
) {
  return page.evaluate(
    async ({ input, slot, target }) => {
      const reg = await navigator.serviceWorker.getRegistration(target);
      const worker = reg?.[slot];
      if (!worker) throw new Error("Missing " + slot + " worker for " + target);
      const { port1, port2 } = new MessageChannel();
      try {
        const result = new Promise<unknown>((resolve, reject) => {
          port1.addEventListener(
            "message",
            (event: MessageEvent<{ value?: unknown; error?: string }>) => {
              if (event.data.error) reject(new Error(event.data.error));
              else resolve(event.data.value);
            },
            { once: true },
          );
          port1.start();
        });
        worker.postMessage(input, [port2]);
        return await result;
      } finally {
        port1.close();
      }
    },
    { input: request, slot: registrationSlot, target: registrationScope },
  );
}

export function windowSubscriptions(
  page: Page,
  operation: "subscribe" | "unsubscribe" | "list",
  ...cookieNames: string[]
) {
  return page.evaluate(
    async ({ action, names, target }) => {
      const reg = await navigator.serviceWorker.getRegistration(target);
      if (!reg) throw new Error("Missing registration " + target);
      if (action !== "list") await reg.cookies[action](names.map((name) => ({ name })));
      return reg.cookies.getSubscriptions();
    },
    { action: operation, names: cookieNames, target: scope },
  );
}

export async function waitForChanges(page: Page, count: number) {
  await expect.poll(() => page.evaluate(() => window.swChanges.length)).toBe(count);
  return page.evaluate(() => window.swChanges);
}

export function deliveryState(fixture: Fixture) {
  return fixture.app.evaluate(
    (_e, url) => globalThis.cookieFixture.workers.deliveryState(url),
    fixture.origins.jar + scope,
  );
}
export function index(fixture: Fixture) {
  return fixture.app.evaluate(() => globalThis.cookieFixture.workers.index());
}
export function running(fixture: Fixture) {
  return fixture.app.evaluate(() => globalThis.cookieFixture.workers.running());
}

export async function detachWorkerDebuggers(context: BrowserContext) {
  // Playwright 1.64 auto-attaches to workers, but only exposes them on its public Chromium context.
  // Detach its actual Electron worker sessions before measuring Chromium's idle termination.
  const connection: { toImpl(context: BrowserContext): { serviceWorkers(): object[] } } = Reflect.get(
    context,
    "_connection",
  );
  for (const worker of connection.toImpl(context).serviceWorkers()) {
    const session: { detach(): Promise<void> } = Reflect.get(worker, "_session");
    await session.detach();
  }
}

export function write(page: Page, name: string, value: string) {
  return page.evaluate((cookie) => cookieStore.set(cookie.name, cookie.value), { name, value });
}
