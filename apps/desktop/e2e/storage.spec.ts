import type { ElectronApplication, Page } from "@playwright/test";

import { expect, pgrep, processRoot, quit, test, waitForApp } from "./desktop.ts";

// Browser storage under app://app: cookies set by script and by a Set-Cookie response header, each
// persistent and session-only, plus localStorage and sessionStorage, observed right away, across a
// reload, a closed and reopened window (macOS keeps the app running), a full quit and relaunch and a
// hard kill on the same user data directory. Server cookies go through the main process's jar
// (src/main/cookie-jar.ts, spec HOST-09). The /__e2e/cookies endpoints exist only with DESKTOP_E2E=1
// (src/e2e-routes.ts).

async function writeAll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const expires = new Date(Date.now() + 60 * 60 * 1000).toUTCString();
    document.cookie = "e2e-script-max-age=sm; Max-Age=3600; Path=/; SameSite=Lax";
    document.cookie = `e2e-script-expires=se; Expires=${expires}; Path=/; SameSite=Lax`;
    document.cookie = "e2e-script-session=ss; Path=/; SameSite=Lax";
    for (const body of [
      { name: "e2e-header-persistent", value: "hp", maxAge: 3600 },
      { name: "e2e-header-session", value: "hs" },
    ]) {
      const response = await fetch("/__e2e/cookies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`POST /__e2e/cookies: ${response.status}`);
    }
    localStorage.setItem("e2e", "local");
    sessionStorage.setItem("e2e", "session");
  });
}

interface Observed {
  /** `e2e-*` cookies `document.cookie` shows (HttpOnly header cookies never appear here). */
  script: Record<string, string>;
  /** `e2e-*` cookies the utility received on a `fetch()`. */
  server: Record<string, string>;
  local: string | null;
  session: string | null;
}

async function observe(page: Page): Promise<Observed> {
  const observed = await page.evaluate(async () => {
    const script: Record<string, string> = {};
    for (const pair of document.cookie.split("; ")) {
      const [name, value] = pair.split("=");
      if (name?.startsWith("e2e-")) script[name] = value ?? "";
    }
    const server: unknown = await (await fetch("/__e2e/cookies")).json();
    return { script, server, local: localStorage.getItem("e2e"), session: sessionStorage.getItem("e2e") };
  });
  return { ...observed, server: cookiesOf(observed.server) };
}

/** The `cookies` of a `GET /__e2e/cookies` body. */
function cookiesOf(body: unknown): Record<string, string> {
  if (typeof body !== "object" || body === null || !("cookies" in body)) throw new Error("not a cookies body");
  const cookies: Record<string, string> = {};
  for (const [name, value] of Object.entries(body.cookies ?? {})) cookies[name] = String(value);
  return cookies;
}

/** The `e2e-*` cookies a top-level document request carried, from the utility's side. */
async function documentCookies(page: Page): Promise<Record<string, string>> {
  await page.goto("app://app/__e2e/cookies");
  const cookies = cookiesOf(JSON.parse((await page.locator("body").textContent()) ?? "{}"));
  await page.goto("app://app/");
  await waitForApp(page);
  return cookies;
}

/** The app session's cookie store as Electron's main process sees it. */
async function storedCookies(app: ElectronApplication) {
  return app.evaluate(async ({ session }) =>
    (await session.fromPartition("persist:app").cookies.get({}))
      .filter((cookie) => cookie.name.startsWith("e2e-"))
      .map(({ name, session: isSession, httpOnly, expirationDate }) => ({
        name,
        session: isSession ?? false,
        httpOnly: httpOnly ?? false,
        expires: expirationDate !== undefined,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
  );
}

/** `POST /__e2e/cookies` from the page: the server answers with one `Set-Cookie`. */
async function postCookie(
  page: Page,
  body: { name: string; value: string; maxAge?: number; path?: string; delete?: boolean; httpOnly?: boolean },
): Promise<void> {
  await page.evaluate(async (cookie) => {
    const response = await fetch("/__e2e/cookies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cookie),
    });
    if (!response.ok) throw new Error(`POST /__e2e/cookies: ${response.status}`);
  }, body);
}

/** The `e2e-*` cookies the utility received on a `fetch()` of `path`. */
async function serverCookies(page: Page, path = "/__e2e/cookies"): Promise<Record<string, string>> {
  return cookiesOf(await page.evaluate(async (url) => (await fetch(url)).json(), path));
}

// Page scripts (2026-10-28, Electron 45): `app` is not a cookieable scheme. Chromium keeps a fixed
// list of schemes that may hold cookies (http, https, ws, wss, optionally file); registering `app` as
// standard and secure does not add it, and Electron has no API that does (electron/electron#27981,
// open). So under app://app `document.cookie` writes are dropped, and the store refuses an app://
// URL. This test pins that, so a change in Electron shows up here.
//
// Server cookies: Chromium ignores `Set-Cookie` on a `protocol.handle` response and sends no
// `Cookie` to one, whatever the scheme. The main process keeps them instead (HOST-09): it stores each
// response's `Set-Cookie` in the session's cookie store under https://app.desktop and adds a `Cookie`
// header to later requests. Header cookies below reach the server; script cookies never do.
const HEADER_COOKIES = { "e2e-header-persistent": "hp", "e2e-header-session": "hs" };

test("page scripts have no cookies under app://: document.cookie writes are dropped", async ({
  desktop: { app, page },
}) => {
  await writeAll(page);
  const observed = await observe(page);
  expect(observed.script).toEqual({});
  expect(Object.keys(observed.server).filter((name) => name.startsWith("e2e-script-"))).toEqual([]);
  expect((await storedCookies(app)).filter(({ name }) => name.startsWith("e2e-script-"))).toEqual([]);
  const direct = await app.evaluate(async ({ session }) =>
    session
      .fromPartition("persist:app")
      .cookies.set({ url: "app://app/", name: "e2e-direct", value: "1" })
      .then(
        () => "set",
        (err: unknown) => String(err),
      ),
  );
  expect(direct).toMatch(/scheme that does not support cookies/);
});

test("a server's Set-Cookie round-trips through the main process to later requests and documents", async ({
  desktop: { app, page },
}) => {
  await writeAll(page);
  expect(await observe(page)).toEqual({ script: {}, server: HEADER_COOKIES, local: "local", session: "session" });
  expect(await documentCookies(page)).toEqual(HEADER_COOKIES);
  // Stored host-only under the jar's https URL, with their attributes; never under app://.
  expect(await storedCookies(app)).toEqual([
    { name: "e2e-header-persistent", session: false, httpOnly: true, expires: true },
    { name: "e2e-header-session", session: true, httpOnly: true, expires: false },
  ]);
  const domains = await app.evaluate(async ({ session }) =>
    (await session.fromPartition("persist:app").cookies.get({}))
      .filter((cookie) => cookie.name.startsWith("e2e-"))
      .map((cookie) => `${cookie.domain} ${cookie.hostOnly} ${cookie.path}`),
  );
  expect(domains).toEqual(["app.desktop true /", "app.desktop true /"]);
});

test("a path-scoped cookie reaches only its path, and Max-Age=0 deletes", async ({ desktop: { page } }) => {
  await postCookie(page, { name: "e2e-root", value: "r", maxAge: 3600 });
  await postCookie(page, { name: "e2e-scoped", value: "s", path: "/__e2e/cookies/scoped" });
  expect(await serverCookies(page)).toEqual({ "e2e-root": "r" });
  // Longer paths first in the Cookie header, as browsers send them.
  expect(await serverCookies(page, "/__e2e/cookies/scoped/deeper")).toEqual({ "e2e-scoped": "s", "e2e-root": "r" });
  expect(await serverCookies(page, "/__e2e/cookies/scopedx")).toEqual({ "e2e-root": "r" });
  // A later Set-Cookie with the same name and path replaces the value.
  await postCookie(page, { name: "e2e-root", value: "r2", maxAge: 3600 });
  expect(await serverCookies(page)).toEqual({ "e2e-root": "r2" });

  await postCookie(page, { name: "e2e-root", value: "x", delete: true });
  expect(await serverCookies(page, "/__e2e/cookies/scoped")).toEqual({ "e2e-scoped": "s" });
  await postCookie(page, { name: "e2e-scoped", value: "x", path: "/__e2e/cookies/scoped", delete: true });
  expect(await serverCookies(page, "/__e2e/cookies/scoped")).toEqual({});
});

test("a non-HttpOnly server cookie round-trips, stays invisible to scripts, and replaces an HttpOnly one", async ({
  desktop: { page },
}) => {
  await postCookie(page, { name: "e2e-plain", value: "p", httpOnly: false });
  expect(await serverCookies(page)).toEqual({ "e2e-plain": "p" });
  // Not HttpOnly, but page scripts still have no cookies under app://.
  expect(await page.evaluate(() => document.cookie)).toBe("");
  // HttpOnly first, then the same name and path without it: a browser replaces the value.
  await postCookie(page, { name: "e2e-swap", value: "h", maxAge: 3600 });
  await postCookie(page, { name: "e2e-swap", value: "plain", maxAge: 3600, httpOnly: false });
  expect(await serverCookies(page)).toEqual({ "e2e-plain": "p", "e2e-swap": "plain" });
});

test("Electron's cookie store matches paths, expiry and Secure the way a browser does", async ({
  desktop: { app },
}) => {
  // What the jar relies on from `cookies.get({ url })`, on a throwaway in-memory partition.
  const result = await app.evaluate(async ({ session }) => {
    const cookies = session.fromPartition("e2e-cookie-semantics").cookies;
    const origin = "https://app.desktop";
    const base = { secure: false, httpOnly: false, sameSite: "lax" as const };
    await cookies.set({ ...base, url: `${origin}/`, name: "root", value: "1", path: "/" });
    await cookies.set({ ...base, url: `${origin}/a`, name: "a", value: "1", path: "/a" });
    await cookies.set({ ...base, url: `${origin}/a/b`, name: "ab", value: "1", path: "/a/b" });
    await cookies.set({ ...base, url: `${origin}/`, name: "sec", value: "1", path: "/", secure: true });
    await cookies.set({ ...base, url: `${origin}/`, name: "strict", value: "1", path: "/", sameSite: "strict" });
    await cookies.set({ ...base, url: `${origin}/`, name: "http", value: "1", path: "/", httpOnly: true });
    const soon = Date.now() / 1000 + 1;
    await cookies.set({ ...base, url: `${origin}/`, name: "soon", value: "1", path: "/", expirationDate: soon });
    const names = async (url: string) => (await cookies.get({ url })).map((cookie) => cookie.name);
    const before = {
      root: await names(`${origin}/`),
      a: await names(`${origin}/a`),
      aSlash: await names(`${origin}/a/`),
      abc: await names(`${origin}/a/b/c`),
      ax: await names(`${origin}/ax`),
      http: await names("http://app.desktop/"),
    };
    // An expired set deletes exactly that name and path; over an HttpOnly cookie only when it is
    // HttpOnly itself (Chromium refuses to replace one otherwise), which is why the jar deletes that way.
    await cookies.set({ ...base, url: `${origin}/a`, name: "a", value: "", path: "/a", expirationDate: 1 });
    const plainOverHttpOnly = await cookies
      .set({ ...base, url: `${origin}/`, name: "http", value: "", path: "/", expirationDate: 1 })
      .then(
        () => "deleted",
        (err: unknown) => String(err),
      );
    const httpOnlyBefore = await names(`${origin}/`);
    await cookies.set({
      ...base,
      url: `${origin}/`,
      name: "http",
      value: "",
      path: "/",
      httpOnly: true,
      expirationDate: 1,
    });
    await cookies.set({ ...base, url: `${origin}/`, name: "missing", value: "", path: "/", expirationDate: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return { before, plainOverHttpOnly, httpOnlyBefore, after: await names(`${origin}/a/b/c`) };
  });
  expect(result.before).toEqual({
    root: ["root", "sec", "strict", "http", "soon"],
    a: ["a", "root", "sec", "strict", "http", "soon"],
    aSlash: ["a", "root", "sec", "strict", "http", "soon"],
    abc: ["ab", "a", "root", "sec", "strict", "http", "soon"],
    ax: ["root", "sec", "strict", "http", "soon"],
    http: ["root", "strict", "http", "soon"],
  });
  expect(result.plainOverHttpOnly).toMatch(/HTTP_ONLY/);
  expect(result.httpOnlyBefore).toContain("http");
  expect(result.after).toEqual(["ab", "root", "sec", "strict"]);
});

test("localStorage and sessionStorage survive a reload, and so do server cookies", async ({ desktop: { page } }) => {
  await writeAll(page);
  await page.reload();
  await waitForApp(page);
  expect(await observe(page)).toEqual({ script: {}, server: HEADER_COOKIES, local: "local", session: "session" });
});

test("a closed and reopened window keeps localStorage and cookies, not sessionStorage", async ({
  desktop: { app, page },
}) => {
  test.skip(process.platform !== "darwin", "only macOS keeps the app running without a window");
  await writeAll(page);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  // A Dock click: the app's `activate` handler opens a new window.
  const reopened = app.waitForEvent("window");
  await app.evaluate(({ app: electronApp }) => {
    electronApp.emit("activate");
  });
  const next = await reopened;
  await waitForApp(next);
  expect(next.url()).toBe("app://app/");
  // The app kept running, so session cookies live on, as in a browser that stays open.
  expect(await observe(next)).toEqual({ script: {}, server: HEADER_COOKIES, local: "local", session: null });
});

test("after quit and relaunch, localStorage and persistent cookies survive, sessionStorage and session cookies do not", async ({
  launchApp,
}) => {
  const first = await launchApp();
  await writeAll(first.page);
  // Quit right after writing: the worst case for storage that reaches the disk lazily.
  await quit(first);
  const second = await launchApp();
  expect(await observe(second.page)).toEqual({
    script: {},
    server: { "e2e-header-persistent": "hp" },
    local: "local",
    session: null,
  });
  expect(await documentCookies(second.page)).toEqual({ "e2e-header-persistent": "hp" });
  // Deleted before quitting: stays deleted after the relaunch.
  await postCookie(second.page, { name: "e2e-header-persistent", value: "x", delete: true });
  await quit(second);
  const third = await launchApp();
  expect(await serverCookies(third.page)).toEqual({});
});

test("a persistent cookie survives a hard kill right after its response", async ({ launchApp, target }) => {
  const first = await launchApp();
  await postCookie(first.page, { name: "e2e-killed", value: "k", maxAge: 3600 });
  // The response has arrived: the jar has stored and flushed the cookie. No quit, no before-quit.
  process.kill(first.pid, "SIGKILL");
  // Every helper (renderer, GPU, utility) follows the main process before the relaunch.
  const until = Date.now() + 10_000;
  while (pgrep(processRoot(target)).length > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  expect(pgrep(processRoot(target))).toEqual([]);
  const second = await launchApp();
  expect(await serverCookies(second.page)).toEqual({ "e2e-killed": "k" });
});

test("a session cookie replacing a persistent one stays replaced after a hard kill", async ({ launchApp, target }) => {
  const first = await launchApp();
  await postCookie(first.page, { name: "e2e-sid", value: "old", maxAge: 600 });
  await postCookie(first.page, { name: "e2e-sid", value: "new" });
  expect(await serverCookies(first.page)).toEqual({ "e2e-sid": "new" });
  // The persistent record must be gone from the disk already: a relaunch must not bring "old" back.
  process.kill(first.pid, "SIGKILL");
  const until = Date.now() + 10_000;
  while (pgrep(processRoot(target)).length > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  expect(pgrep(processRoot(target))).toEqual([]);
  const second = await launchApp();
  expect(await serverCookies(second.page)).toEqual({});
});
