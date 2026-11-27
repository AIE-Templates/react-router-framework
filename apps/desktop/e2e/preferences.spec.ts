import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Page } from "@playwright/test";
import type { DesktopRequest } from "@repo/shared";

import { expect, quit, test, waitForApp } from "./desktop.ts";
import { isSsrBuild } from "./visual-mirror.ts";

// Preferences under app://app (HOST-08): the page writes them through the preload bridge, the main
// process keeps them (and prefs.json in the user data directory) and sends them with every request
// as `x-desktop-prefs`, so server rendering sees them after a reload and after a relaunch. The app's
// code uses `useSetPreference()` from `~/platform/electron/preferences`; these tests call the bridge underneath it.

const KEY = "e2eProbe";
const VALUE = "e2e-pref-value-7f3a";

/** `window.desktop.setPref`/`removePref` from the page, with the bridge's result. */
async function setPref(page: Page, key: string, value: string | null): Promise<unknown> {
  return page.evaluate(async ([k, v]) => (v === null ? window.desktop!.removePref(k) : window.desktop!.setPref(k, v)), [
    key,
    value,
  ] as const);
}

// CDP can lose no-store response bodies after the hydrated Router consumes them.
function committedPreference(page: Page, key: string) {
  return page.evaluate((name) => {
    const router: { state: { loaderData: { root: { desktop: DesktopRequest } } } } = Reflect.get(
      window,
      "__reactRouterDataRouter",
    );
    return router.state.loaderData.root.desktop.prefs[name];
  }, key);
}

/**
 * Whether the server rendered the preference: the reloaded document's serialized loader data (the
 * root loader returns the desktop facts, preferences included) and a fresh SSR document request.
 */
async function rendered(page: Page): Promise<{ document: boolean; fetched: boolean }> {
  return page.evaluate(async (value) => {
    const inDocument = [...document.scripts].some((script) => script.textContent?.includes(value));
    const html = await (await fetch("/", { headers: { accept: "text/html" } })).text();
    return { document: inDocument, fetched: html.includes(value) };
  }, VALUE);
}

async function reload(page: Page): Promise<void> {
  await page.reload();
  await waitForApp(page);
}

test("a preference set from the page reaches server rendering after a reload, and its removal too", async ({
  desktop: { page },
}) => {
  test.skip(!(await isSsrBuild(page)), "Request-time preference rendering requires SSR");
  expect(await rendered(page)).toEqual({ document: false, fetched: false });
  expect(await setPref(page, KEY, VALUE)).toEqual({ status: "applied" });
  // No reload needed for requests: the very next one carries it.
  expect((await rendered(page)).fetched).toBe(true);
  await reload(page);
  expect(await rendered(page)).toEqual({ document: true, fetched: true });

  expect(await setPref(page, KEY, null)).toEqual({ status: "applied" });
  await reload(page);
  expect(await rendered(page)).toEqual({ document: false, fetched: false });
});

test("invalid preferences are rejected and change nothing", async ({ desktop: { page } }) => {
  expect(await setPref(page, "bad key", VALUE)).toEqual({ status: "rejected", reason: "invalid-key" });
  expect(await setPref(page, KEY, "x".repeat(5000))).toEqual({ status: "rejected", reason: "invalid-value" });
  if (!(await isSsrBuild(page))) return;
  // A forged header from the page is replaced by the main process's own.
  const forged = await page.evaluate(async (value) => {
    const html = await (
      await fetch("/", { headers: { accept: "text/html", "x-desktop-prefs": JSON.stringify({ e2eProbe: value }) } })
    ).text();
    return html.includes(value);
  }, VALUE);
  expect(forged).toBe(false);
});

test("a preference survives quitting and relaunching on the same user data", async ({ launchApp, userDataDir }) => {
  const first = await launchApp();
  expect(await first.page.evaluate(() => window.desktop!.readVisual())).toEqual({ record: null, pending: false });
  expect(await setPref(first.page, KEY, VALUE)).toEqual({ status: "applied" });
  // Quit right after writing: the store writes prefs.json before answering.
  await quit(first);
  const second = await launchApp();
  if (await isSsrBuild(second.page)) expect(await rendered(second.page)).toEqual({ document: true, fetched: true });
  // A second write serializes the relaunched main process's in-memory preferences in either build.
  expect(await setPref(second.page, "afterRestart", "yes")).toEqual({ status: "applied" });
  const file = join(userDataDir, "prefs.json");
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ [KEY]: VALUE, afterRestart: "yes" });
  expect(await setPref(second.page, KEY, null)).toEqual({ status: "applied" });
  expect(JSON.parse(await readFile(file, "utf8"))).not.toHaveProperty(KEY);
  expect(await second.page.evaluate(() => window.desktop!.visualSeed)).toEqual({ record: null, pending: false });
});

test("desktop writes enforce the application-prefixed cookie budget", async ({ desktop: { page } }) => {
  const keys = ["budget0", "budget1", "budget2", "budget3"];
  try {
    for (const key of keys.slice(0, 3))
      expect(await setPref(page, key, "x".repeat(1000))).toEqual({ status: "applied" });
    // JSON remains below the limit, but four named cookies exceed the shared 4 KiB budget.
    expect(await setPref(page, keys[3], "x".repeat(1000))).toEqual({ status: "rejected", reason: "too-large" });
  } finally {
    for (const key of keys) expect(await setPref(page, key, null)).toEqual({ status: "applied" });
  }
});

test("open peer windows revalidate on preference writes and removals", async ({ desktop: { app, page } }) => {
  test.skip(!(await isSsrBuild(page)), "Peer loader revalidation requires SSR");
  const opened = app.waitForEvent("window");
  await page.evaluate(() => {
    window.open("/?peer=1");
  });
  const peer = await opened;
  await waitForApp(peer);
  for (const [source, receiver, value] of [
    [page, peer, VALUE],
    [peer, page, null],
  ] as const) {
    // Direct bridge writes notify peers only. Seed the original writer's loader before testing removal.
    if (value === null) await reload(receiver);
    await expect.poll(() => committedPreference(receiver, KEY)).toBe(value === null ? VALUE : undefined);
    const updated = receiver.waitForResponse((response) => new URL(response.url()).pathname.endsWith(".data"));
    expect(await setPref(source, KEY, value)).toEqual({ status: "applied" });
    const response = await updated;
    expect(response.ok()).toBe(true);
    await expect.poll(() => committedPreference(receiver, KEY)).toBe(value ?? undefined);
  }
});

test("a burst of preference changes reaches the peer's loaders with the final value", async ({
  desktop: { app, page },
}) => {
  test.skip(!(await isSsrBuild(page)), "Peer loader revalidation requires SSR");
  const opened = app.waitForEvent("window");
  await page.evaluate(() => {
    window.open("/?burst", "_blank", "noopener");
  });
  const peer = await opened;
  await waitForApp(peer);
  let requests = 0;
  const failures: string[] = [];
  peer.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith(".data")) requests++;
  });
  // The Router aborts a revalidation that a newer one supersedes; any other failure is a real error.
  peer.on("requestfailed", (request) => {
    const error = request.failure()!.errorText;
    if (new URL(request.url()).pathname.endsWith(".data") && error !== "net::ERR_ABORTED") failures.push(error);
  });
  const final = "final-peer-value";
  await page.evaluate(async (last) => {
    for (let i = 0; i < 60; i++) {
      const update = await window.desktop!.setPref("burst", i === 59 ? last : i);
      if (update.status !== "applied") throw new Error("Preference rejected");
    }
  }, final);
  await expect.poll(() => committedPreference(peer, "burst")).toBe(final);
  expect(failures).toEqual([]);
  expect(requests).toBeGreaterThan(0);
  expect(requests).toBeLessThan(60);
});
