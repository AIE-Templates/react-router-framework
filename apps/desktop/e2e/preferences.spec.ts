import type { Page } from "@playwright/test";

import { expect, quit, test, waitForApp } from "./desktop.ts";

// Preferences under app://app (HOST-08): the page writes them through the preload bridge, the main
// process keeps them (and prefs.json in the user data directory) and sends them with every request
// as `x-desktop-prefs`, so server rendering sees them after a reload and after a relaunch. The app's
// code uses `useSetPreference()` from `~/lib/preferences`; these tests call the bridge underneath it.

const KEY = "e2eProbe";
const VALUE = "e2e-pref-value-7f3a";

/** `window.desktop.setPref`/`removePref` from the page, with the bridge's result. */
async function setPref(page: Page, key: string, value: string | null): Promise<unknown> {
  return page.evaluate(async ([k, v]) => (v === null ? window.desktop!.removePref(k) : window.desktop!.setPref(k, v)), [
    key,
    value,
  ] as const);
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
  // A forged header from the page is replaced by the main process's own.
  const forged = await page.evaluate(async (value) => {
    const html = await (
      await fetch("/", { headers: { accept: "text/html", "x-desktop-prefs": JSON.stringify({ e2eProbe: value }) } })
    ).text();
    return html.includes(value);
  }, VALUE);
  expect(forged).toBe(false);
});

test("a preference survives quitting and relaunching on the same user data", async ({ launchApp }) => {
  const first = await launchApp();
  expect(await setPref(first.page, KEY, VALUE)).toEqual({ status: "applied" });
  // Quit right after writing: the store writes prefs.json before answering.
  await quit(first);
  const second = await launchApp();
  expect(await rendered(second.page)).toEqual({ document: true, fetched: true });
});
