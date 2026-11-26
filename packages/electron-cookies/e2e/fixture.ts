import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _electron as electron, expect, type Page, test as base } from "@playwright/test";

import type { Reply } from "./app/main.ts";

export type Site = keyof typeof globalThis.cookieFixture.origins;

function certificate(profile: string) {
  const cert = join(profile, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=cookie.test",
      "-keyout",
      join(profile, "key.pem"),
      "-out",
      cert,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

function certificateHash(profile: string) {
  const cert = join(profile, "cert.pem");
  const key = new X509Certificate(readFileSync(cert)).publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(key).digest("base64");
}

const reported = new Set<string>();
async function launch(profile: string, upstreamHost: string, taskTimeoutMs: number | undefined) {
  const executablePath: unknown = createRequire(import.meta.url)("electron");
  if (typeof executablePath !== "string") throw new Error("Missing Electron executable");
  const app = await electron.launch({
    executablePath,
    args: [
      join(import.meta.dirname, "app"),
      "--user-data-dir=" + profile,
      "--no-proxy-server",
      "--use-mock-keychain",
      "--password-store=basic",
      "--ignore-certificate-errors-spki-list=" + certificateHash(profile),
    ],
    env: {
      ...process.env,
      COOKIE_FIXTURE_UPSTREAM_HOST: upstreamHost,
      COOKIE_FIXTURE_TASK_TIMEOUT_MS: taskTimeoutMs?.toString() ?? "",
    },
  });
  // Playwright releases its process lookup on exit. Keep this launch's handle for teardown.
  const child = app.process();
  async function close() {
    if (child.exitCode === null && child.signalCode === null) await app.close();
  }
  try {
    const page = await app.firstWindow();
    const { origins, storageOrigin, versions, pid, userData } = await app.evaluate(({ app: main }) => ({
      origins: globalThis.cookieFixture.origins,
      storageOrigin: globalThis.cookieFixture.storageOrigin,
      versions: { electron: process.versions.electron, chrome: process.versions.chrome },
      pid: process.pid,
      userData: main.getPath("userData"),
    }));
    expect(realpathSync(userData)).toBe(realpathSync(profile));
    await page.waitForURL(origins.jar + "/");
    const label = "Electron " + versions.electron + " / Chromium " + versions.chrome;
    if (!reported.has(label)) {
      reported.add(label);
      process.stdout.write(label + "\n");
    }
    base.info().annotations.push({ type: "runtime", description: label });
    await base.info().attach("process.versions", { body: JSON.stringify(versions), contentType: "application/json" });
    let previousSite: Site = "jar";
    return {
      app,
      close,
      page,
      origins,
      storageOrigin,
      async visit(site: Site, path = "/") {
        if (previousSite !== "jar" && previousSite !== site) {
          // Unload the previous client (including its pagehide writes) before clearing its registration.
          await page.goto("about:blank");
          await app.evaluate(async ({ session }, origin) => {
            await session.defaultSession.clearData({
              origins: [origin],
              dataTypes: ["cookies", "serviceWorkers"],
              originMatchingMode: "origin-in-all-contexts",
            });
          }, origins[previousSite]);
        }
        await page.goto(origins[site] + path);
        previousSite = site;
      },
      async attachObservation(site: Site, observed: unknown) {
        const path = join(profile, "observed-" + site + ".json");
        writeFileSync(path, JSON.stringify(observed, null, 2) ?? "null");
        await base.info().attach("observed-" + site, { path, contentType: "application/json" });
      },
      async peer(site: Site, path = "/") {
        const url = origins[site] + path;
        const [peer] = await Promise.all([
          app.waitForEvent("window"),
          app.evaluate((_electron, target) => globalThis.cookieFixture.openWindow(target), url),
        ]);
        await peer.waitForURL(url);
        return peer;
      },
      async replyPath(cookies: string[], path = "/account/set", date?: string) {
        const id = await app.evaluate((_electron, reply: Reply) => globalThis.cookieFixture.addReply(reply), {
          cookies,
          date,
        });
        return path + "?reply=" + id;
      },
      async set(cookies: string[], path?: string, date?: string) {
        return requestCookie(page, await this.replyPath(cookies, path, date));
      },
      async stored(site: Site) {
        const host = new URL(site === "jar" ? storageOrigin : origins[site]).hostname;
        // Filtering by URL here would hide path-scoped records. Preserve the leading dot and
        // every other Electron field, replacing only this site's exact hostname.
        const cookies = await app.evaluate(
          async ({ session }, filter) => session.defaultSession.cookies.get(filter),
          site === "jar" ? {} : { domain: host },
        );
        if (site === "jar") {
          expect(
            cookies.filter((c) => c.domain !== host && c.domain !== "." + host),
            "unexpected session cookie domains",
          ).toEqual([]);
        }
        return cookies
          .map((cookie) => ({
            ...cookie,
            domain: cookie.domain === host ? "HOST" : cookie.domain === "." + host ? ".HOST" : cookie.domain,
          }))
          .toSorted((a, b) =>
            [a.name, a.domain, a.path, a.value]
              .join("\n")
              .localeCompare([b.name, b.domain, b.path, b.value].join("\n")),
          );
      },
      async kill() {
        const exited = once(child, "exit");
        // Playwright gives the fixture its own POSIX process group. Kill Chromium's disk
        // writer too so it cannot flush after the simulated crash.
        if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
        else {
          expect(child.pid).toBe(pid);
          process.kill(-pid, "SIGKILL");
        }
        await exited;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function requestCookie(page: Page, path = "/echo") {
  return page.evaluate(async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Fixture response " + response.status + " for " + url);
    return response.text();
  }, path);
}

export type Fixture = Awaited<ReturnType<typeof launch>>;
export const test = base.extend<{
  fixture: Fixture;
  restart: (mode: "quit" | "kill") => Promise<Fixture>;
  upstreamHost: string;
  taskTimeoutMs: number | undefined;
}>({
  taskTimeoutMs: [undefined, { option: true }],
  upstreamHost: ["127.0.0.1", { option: true }],
  fixture: async ({ upstreamHost, taskTimeoutMs }, provide) => {
    const profile = mkdtempSync(join(tmpdir(), "electron-cookies-"));
    try {
      certificate(profile);
      const fixture = await launch(profile, upstreamHost, taskTimeoutMs);
      try {
        await provide(fixture);
      } finally {
        await fixture.close();
      }
    } finally {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    }
  },
  restart: async ({ fixture, upstreamHost, taskTimeoutMs }, provide) => {
    const profile = await fixture.app.evaluate(({ app }) => app.getPath("userData"));
    let second: Fixture | undefined;
    try {
      await provide(async (mode) => {
        if (mode === "quit") await fixture.close();
        else await fixture.kill();
        second = await launch(profile, upstreamHost, taskTimeoutMs);
        return second;
      });
    } finally {
      await second?.close();
    }
  },
});
export { expect };

/** Run the same page operations in three isolated cookie namespaces in the same Chromium build. */
export async function compareNative<T>(
  fixture: Fixture,
  path: string,
  observe: (site: Site) => Promise<T>,
  // The result goes to toEqual, so it may contain asymmetric matchers.
  expectedJar: (native: T) => unknown = (native) => native,
) {
  const results = new Map<Site, T>();
  for (const site of ["localhost", "https", "jar"] as const) {
    await test.step(site, async () => {
      await fixture.visit(site, path);
      expect(
        await fixture.app.evaluate(({ session }) => session.defaultSession.cookies.get({})),
        "comparison starts empty",
      ).toEqual([]);
      const observed = await observe(site);
      results.set(site, observed);
      await fixture.attachObservation(site, observed);
      if (site === "jar") await fixture.stored(site);
    });
  }
  const jar: unknown = results.get("jar");
  expect(jar, "https ordinary domain").toEqual(expectedJar(results.get("https")!));
  expect(jar, "http localhost").toEqual(expectedJar(results.get("localhost")!));
}
