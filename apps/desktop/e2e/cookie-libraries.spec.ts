import { expect, test } from "./desktop.ts";

declare global {
  interface Window {
    axios: { get(url: string): Promise<{ data: { header: string | null } }> };
    Cookies: {
      set(name: string, value: string, attributes: { path: string; expires: number }): void;
      get(name: string): string | undefined;
      remove(name: string, attributes: { path: string }): void;
    };
    i18next: {
      use(module: unknown): Window["i18next"];
      init(options: Record<string, unknown>): Promise<unknown>;
      changeLanguage(language: string): Promise<unknown>;
      language: string;
    };
    i18nextBrowserLanguageDetector: unknown;
  }
}

test("LIB-01 | axios sends the server-issued XSRF-TOKEN on its next same-origin request", async ({
  desktop: { page },
}) => {
  await page.addScriptTag({ url: "/__e2e/scripts/axios.js" });
  expect(
    await page.evaluate(async () => {
      const client = window.axios;
      const read = async () => (await client.get("/__e2e/xsrf/echo")).data.header;
      const before = await read();
      await window.axios.get("/__e2e/xsrf/token");
      return [before, await read()];
    }),
  ).toEqual([null, "e2e-xsrf"]);
});

test("LIB-02 | js-cookie sets, reads and removes a persistent path-scoped cookie", async ({ desktop: { page } }) => {
  await page.goto("app://app/__e2e/navigation/frame");
  await page.addScriptTag({ url: "/__e2e/scripts/js-cookie.js" });
  const result = await page.evaluate(async () => {
    const name = "e2e-library";
    const path = "/__e2e";
    const echo = async () => {
      const body: unknown = await (await fetch(path + "/cookies")).json();
      if (!body || typeof body !== "object" || !("cookies" in body)) throw new Error("Missing cookie echo");
      return body.cookies;
    };
    window.Cookies.set(name, "two words", { path, expires: 1 });
    const value = window.Cookies.get(name);
    const item = await cookieStore.get(name);
    const before = await echo();
    window.Cookies.remove(name, { path: "/" });
    const afterWrongPath = window.Cookies.get(name);
    window.Cookies.remove(name, { path });
    return {
      value,
      path: item && "path" in item && item.path,
      persistent: Number(item && "expires" in item && item.expires) > Date.now(),
      before,
      afterWrongPath,
      removed: window.Cookies.get(name) === undefined,
      after: await echo(),
    };
  });
  expect(result).toEqual({
    value: "two words",
    path: "/__e2e",
    persistent: true,
    before: { "e2e-library": "two%20words" },
    afterWrongPath: "two words",
    removed: true,
    after: {},
  });
});

test("LIB-03 | i18next-browser-languagedetector reads the language cookie and writes the change back", async ({
  desktop: { page },
}) => {
  await page.goto("app://app/__e2e/navigation/frame");
  await page.addScriptTag({ url: "/__e2e/scripts/i18next.js" });
  await page.addScriptTag({ url: "/__e2e/scripts/i18next-language-detector.js" });
  const result = await page.evaluate(async () => {
    document.cookie = "e2e-lang=de; path=/";
    const i18n = window.i18next.use(window.i18nextBrowserLanguageDetector);
    await i18n.init({
      supportedLngs: ["de", "en", "fr"],
      fallbackLng: "en",
      resources: {},
      detection: { order: ["cookie"], lookupCookie: "e2e-lang", caches: ["cookie"] },
    });
    const detected = i18n.language;
    await i18n.changeLanguage("fr");
    const echo: unknown = await (await fetch("/__e2e/cookies")).json();
    return { detected, script: document.cookie, server: echo };
  });
  expect(result.detected).toBe("de");
  expect(result.script).toContain("e2e-lang=fr");
  expect(result.server).toMatchObject({ cookies: { "e2e-lang": "fr" } });
});
