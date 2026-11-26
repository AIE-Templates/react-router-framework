import { writeFile } from "node:fs/promises";

import { visualRecordKernel as records } from "@repo/shared";
import type { BrowserWindow } from "electron";

import { APP_ORIGIN, isAppUrl } from "~/main/app-url.ts";
import type { BootProfile } from "~/main/boot-profile.ts";
import type { Logger } from "~/main/log.ts";

import { runLayoutSmoke } from "./layout-smoke.ts";

/** The `sse` check's stream: enough events, spaced widely enough, to tell streaming from buffering. */
const SMOKE_SSE_EVENTS = 6;
const SMOKE_SSE_INTERVAL_MS = 150;
/** How soon a cancel in the renderer must show up as an aborted `request.signal` in the utility. */
const SMOKE_ABORT_BOUND_MS = 2_000;

/** Shared with the regression test: execute the same serialized function as the renderer. */
export const documentHydrationScript = `return await (${waitForDocumentHydration.toString()})(5000);`;

async function waitForDocumentHydration(timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (document.documentElement.dataset.hydrated !== "true" && Date.now() < until) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return document.documentElement.dataset.hydrated === "true";
}

interface Check {
  ok: boolean;
  /** Not run on purpose; never counted as a pass of what it would have checked. */
  skipped?: true;
  reason?: string;
  detail?: unknown;
}

/**
 * `DESKTOP_SMOKE=1`: once the page has loaded, run checks inside it and print `SMOKE_RESULT {...}`,
 * then return the exit code for the checks. How the shell is verified without a browser driver. In
 * development (`development: true`) the Vite dev server serves modules and CSS differently, so the
 * production-only checks are skipped or relaxed, and the result says which.
 */
export async function runSmoke(
  win: BrowserWindow,
  {
    profile,
    log,
    development = false,
    smokeRoutes = false,
    layout = false,
    screenshot,
  }: {
    profile: BootProfile;
    log: Logger;
    development?: boolean;
    /** Whether the utility serves the `/__smoke/*` endpoints; not without a utility (development), which skips `sse`. */
    smokeRoutes?: boolean;
    /** Explicit template fixture suite; application smoke never depends on the demo route. */
    layout?: boolean;
    /** `DESKTOP_SMOKE_SCREENSHOT=<file.png>`: where to save what the window shows after the checks. */
    screenshot?: string;
  },
): Promise<number> {
  const js = (code: string): Promise<unknown> =>
    Promise.race([
      win.webContents.executeJavaScript(`(async () => { ${code} })()`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("smoke step timed out")), 10_000)),
    ]);
  const rendererErrors: string[] = [];
  const onConsole = (event: { message: string }) => {
    if (/hydration|Minified React error|Uncaught (?:Error|TypeError|ReferenceError)/i.test(event.message))
      rendererErrors.push(event.message);
  };
  win.webContents.on("console-message", onConsole);
  const checks: Record<string, Check> = {};
  const check = async (name: string, code: string, pass: (value: unknown) => boolean) => {
    try {
      const value = await js(code);
      checks[name] = { ok: pass(value), detail: value };
    } catch (err) {
      checks[name] = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  };
  const skip = (name: string, reason: string) => {
    checks[name] = { ok: true, skipped: true, reason };
  };

  // `data-hydrated` is set by the root Layout in an effect, so it proves the client bundle loaded,
  // ran and React hydrated; a page whose scripts were blocked or crashed never gets it.
  await check(
    "document",
    `const d = document.documentElement; const until = Date.now() + 5000; while ((d.dataset.hydrated !== "true" || d.dataset.shell !== "desktop") && Date.now() < until) await new Promise((r) => setTimeout(r, 50)); return { href: location.href, origin: location.origin, shell: d.dataset.shell, platform: d.dataset.platform, titlebar: d.dataset.titlebar, chromeMode: d.dataset.chromeMode, fullscreen: d.dataset.fullscreen, hydrated: d.dataset.hydrated === "true" }`,
    (v) =>
      isRecord(v) &&
      v.origin === APP_ORIGIN &&
      v.shell === "desktop" &&
      typeof v.platform === "string" &&
      (v.chromeMode === "system-decorated" || v.chromeMode === "native-overlay") &&
      v.hydrated === true,
  );
  await check(
    "api",
    `const r = await fetch("/api/health"); return { status: r.status, body: await r.json(), requestId: !!r.headers.get("x-request-id") }`,
    (v) => isRecord(v) && v.status === 200 && v.requestId === true,
  );
  // Hashed, immutable assets exist only in a production build.
  if (development) {
    skip("asset", "the dev server serves modules, not hashed immutable assets");
  } else {
    await check(
      "asset",
      `const l = document.querySelector("link[rel=modulepreload][href],link[rel=stylesheet][href]"); const href = l?.href ?? performance.getEntriesByType("resource").map((entry) => entry.name).find((name) => new URL(name).pathname.startsWith("/assets/")); if (!href) return { status: 0, note: "no production asset found" }; const r = await fetch(href); return { status: r.status, cacheControl: r.headers.get("cache-control"), href }`,
      (v) =>
        isRecord(v) && v.status === 200 && typeof v.cacheControl === "string" && v.cacheControl.includes("immutable"),
    );
  }
  await check(
    "api404",
    `const r = await fetch("/api/missing"); return { status: r.status, json: await r.json() }`,
    (v) => isRecord(v) && v.status === 404,
  );
  await check(
    "formPost",
    `const r = await fetch("/api/health", { method: "POST", body: new URLSearchParams({ a: "1" }) }); return { status: r.status, note: "404 means the CSRF check passed (no POST route); 403 would be an origin mismatch" }`,
    (v) => isRecord(v) && v.status === 404,
  );
  await check(
    "preload",
    `const bridge = window.desktop; return bridge ? { platform: bridge.platform, version: bridge.version, bootstrap: bridge.bootstrap } : null`,
    (v) => isRecord(v) && typeof v.platform === "string",
  );

  const checkChrome = async (suffix = "") => {
    await check(
      `chromeBootstrap${suffix}`,
      `const d = document.documentElement; const b = window.desktop?.bootstrap; return { protocol: b?.protocolVersion, kind: b?.shell.kind, platform: b?.shell.platform, htmlPlatform: d.dataset.platform, mode: b?.mode, htmlMode: d.dataset.chromeMode, shell: d.dataset.shell }`,
      (v) =>
        isRecord(v) &&
        v.protocol === 1 &&
        v.kind === "desktop" &&
        v.shell === "desktop" &&
        v.platform === v.htmlPlatform &&
        v.mode === v.htmlMode &&
        (v.mode === "system-decorated" || v.mode === "native-overlay"),
    );
    await check(
      `chromeState${suffix}`,
      `const bridge = window.desktop; let calls = 0; let unsubscribe; const state = await new Promise((resolve) => { unsubscribe = bridge.subscribeWindowState((value) => { calls++; resolve(value); }); }); unsubscribe(); unsubscribe(); const before = calls; let stop; const next = await new Promise((resolve) => { stop = bridge.subscribeWindowState(resolve); }); stop(); await new Promise((resolve) => setTimeout(resolve, 20)); return { state, next, before, after: calls, unsubscribe: typeof unsubscribe };`,
      (v) =>
        isRecord(v) &&
        validWindowState(v.state) &&
        validWindowState(v.next) &&
        v.before === v.after &&
        v.unsubscribe === "function",
    );
  };
  await checkChrome();
  await check(
    "chromeAppearanceInvalid",
    `return await window.desktop.declareOverlayAppearance({owner:"smoke", revision:1, appearance:{ color:"url(bad)", height:-1, extra:true }})`,
    (v) => isRecord(v) && v.status === "rejected" && v.reason === "invalid-appearance",
  );
  await check(
    "chromeSafety",
    `const root = document.querySelector(".root-frame"); const fallback = root?.querySelector(":scope > .root-chrome-fallback"); const content = root?.querySelector(":scope > .root-content"); if (!fallback || !content) return { missing: true }; const overlay = navigator.windowControlsOverlay; const rect = overlay?.getTitlebarAreaRect(); const safeTop = overlay?.visible ? rect.y + rect.height : 0;
      const fallbackActive = getComputedStyle(fallback).display !== "none";
      const dragSurfaces = root.querySelectorAll(".window-safe-drag, .shell-titlebar-content[data-window-drag], [data-window-header=primary][data-window-drag]");
      const drag = [...dragSurfaces].find(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top < innerHeight &&
          style.visibility === "visible" && style.getPropertyValue("app-region") === "drag" &&
          [0.05, 0.25, 0.5, 0.75, 0.95].some(fraction => {
            const hit = document.elementFromPoint(rect.left + fraction * rect.width, rect.top + rect.height / 2);
            if (!hit || !element.contains(hit)) return false;
            for (let node = hit; node !== element; node = node.parentElement) {
              if (getComputedStyle(node).getPropertyValue("app-region") === "no-drag") return false;
            }
            return true;
          });
      });
      const shell = content.querySelector(":scope > .app-shell"); const ready = shell?.hasAttribute("data-chrome-ready"); let fallbackHeight, fallbackContentTop; try { shell?.removeAttribute("data-chrome-ready"); fallbackHeight = fallback.getBoundingClientRect().height; fallbackContentTop = content.getBoundingClientRect().top; } finally { if (ready) shell.setAttribute("data-chrome-ready", ""); } const controls = [...root.querySelectorAll("button, input, select, a[href]")].map((element) => element.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0); return { mode: document.documentElement.dataset.chromeMode, fullscreen: document.documentElement.dataset.fullscreen === "true", overlayVisible: overlay?.visible ?? false, safeTop, fallbackHeight, fallbackContentTop, fallbackActive, drag: !!drag, dragStyle: drag ? getComputedStyle(drag).getPropertyValue("app-region") : "", overlap: controls.some((r) => r.top < safeTop - 1 && !(rect && r.left >= rect.x - 1 && r.right <= rect.x + rect.width + 1 && r.top >= rect.y - 1)), controls: controls.length };`,
    (v) =>
      isRecord(v) &&
      ((v.drag === true && v.dragStyle === "drag") ||
        (v.fallbackActive === true && v.safeTop === 0 && (v.mode === "system-decorated" || v.fullscreen === true))) &&
      v.overlap === false &&
      typeof v.safeTop === "number" &&
      typeof v.fallbackHeight === "number" &&
      typeof v.fallbackContentTop === "number" &&
      Math.abs(v.fallbackHeight - v.safeTop) <= 1 &&
      v.fallbackContentTop >= v.safeTop - 1 &&
      (v.mode !== "native-overlay" || v.fullscreen === true || (v.overlayVisible === true && v.safeTop > 0)),
  );
  // Stylesheets must apply: a wrong MIME type or a CSP violation would leave the page unstyled while
  // every other check passes. In development Vite injects CSS as <style> elements, so only the
  // applied result (a sheet, the reset margin) is checked there.
  await check(
    "styles",
    `const links = [...document.querySelectorAll("link[rel=stylesheet]")]; return { links: links.map((l) => ({ href: l.getAttribute("href"), applied: l.sheet !== null, rules: l.sheet ? l.sheet.cssRules.length : 0 })), sheets: document.styleSheets.length, bodyFont: getComputedStyle(document.body).fontFamily, bodyMargin: getComputedStyle(document.body).margin }`,
    (v) =>
      isRecord(v) &&
      (development
        ? typeof v.sheets === "number" && v.sheets > 0 && v.bodyMargin === "0px"
        : Array.isArray(v.links) &&
          v.links.length > 0 &&
          v.links.every((l) => isRecord(l) && l.applied === true && typeof l.rules === "number" && l.rules > 0)),
  );
  // Server-sent events through the whole path (renderer → app:// → main → port-fetch → utility →
  // Hono's streamSSE), on the smoke-only /__smoke/* endpoints (diagnostics/smoke/routes.ts): events arrive
  // one by one while the stream is open (not buffered to the end), and a cancel in the renderer
  // aborts `request.signal` in the utility within `SMOKE_ABORT_BOUND_MS`. That a body outlives the
  // headers timeout is covered by port-fetch's unit tests, not here: the smoke keeps the real 60 s.
  if (!smokeRoutes) {
    skip("sse", "development: no utility process, so no smoke endpoints (they live in the utility)");
  } else {
    const interval = SMOKE_SSE_INTERVAL_MS;
    const count = SMOKE_SSE_EVENTS;
    await check(
      "sse",
      `const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const tag = () => "smoke-" + Math.random().toString(36).slice(2); const status = async (id) => (await fetch("/__smoke/sse-status?id=" + id)).json();
      const id = tag(); const t0 = performance.now(); const r = await fetch("/__smoke/sse?id=" + id + "&count=${count}&interval=${interval}");
      const headersMs = performance.now() - t0; const reader = r.body.pipeThrough(new TextDecoderStream()).getReader(); let buffer = ""; let reads = 0; let endMs = null; const events = [];
      for (;;) { const { done, value } = await reader.read(); if (done) break; reads++; buffer += value; let k; while ((k = buffer.indexOf("\\n\\n")) >= 0) { const block = buffer.slice(0, k); buffer = buffer.slice(k + 2); const at = Math.round(performance.now() - t0); if (/^event: end$/m.test(block)) endMs = at; else events.push(at); } }
      const doneMs = Math.round(performance.now() - t0); const server = await status(id);
      const id2 = tag(); const controller = new AbortController(); const r2 = await fetch("/__smoke/sse?id=" + id2 + "&count=50&interval=100", { signal: controller.signal }); const first = await r2.body.getReader().read();
      controller.abort(); const tAbort = performance.now(); let cancelled = await status(id2); while (!cancelled.aborted && performance.now() - tAbort < ${SMOKE_ABORT_BOUND_MS}) { await sleep(20); cancelled = await status(id2); }
      const abortObservedMs = Math.round(performance.now() - tAbort); await sleep(250); const settled = await status(id2);
      return { status: r.status, contentType: r.headers.get("content-type"), headersMs: Math.round(headersMs), events, endMs, doneMs, reads, server, abort: { firstEvent: !first.done, observedMs: abortObservedMs, server: cancelled, eventsAfter250ms: settled.events } };`,
      (v) =>
        isRecord(v) &&
        v.status === 200 &&
        typeof v.contentType === "string" &&
        v.contentType.startsWith("text/event-stream") &&
        sseStreamed(v, { count, interval }) &&
        isRecord(v.abort) &&
        v.abort.firstEvent === true &&
        isRecord(v.abort.server) &&
        v.abort.server.aborted === true &&
        typeof v.abort.observedMs === "number" &&
        v.abort.observedMs < SMOKE_ABORT_BOUND_MS &&
        // The utility's loop stopped: at most the write already in flight at the abort landed after it.
        typeof v.abort.eventsAfter250ms === "number" &&
        typeof v.abort.server.events === "number" &&
        v.abort.server.events < 50 &&
        v.abort.eventsAfter250ms <= v.abort.server.events + 1,
    );
  }

  if (layout) {
    try {
      const result = await runLayoutSmoke(win);
      checks.layoutMatrix = { ok: result.ok, detail: result };
    } catch (error) {
      checks.layoutMatrix = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  // A real document reload must recreate the preload and document-scoped IPC subscription.
  try {
    await new Promise<void>((resolve, reject) => {
      const finished = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        win.webContents.off("did-finish-load", finished);
        reject(new Error("smoke reload timed out"));
      }, 10_000);
      win.webContents.once("did-finish-load", finished);
      win.webContents.reload();
    });
    await check(
      "documentReload",
      `const d = document.documentElement; const until = Date.now() + 5000; while ((d.dataset.hydrated !== "true" || d.dataset.shell !== "desktop") && Date.now() < until) await new Promise((r) => setTimeout(r, 50)); return { hydrated: d.dataset.hydrated, shell: d.dataset.shell, mode: d.dataset.chromeMode, href: location.href };`,
      (v) =>
        isRecord(v) &&
        v.hydrated === "true" &&
        v.shell === "desktop" &&
        (v.mode === "system-decorated" || v.mode === "native-overlay") &&
        typeof v.href === "string" &&
        isAppUrl(v.href),
    );
    await checkChrome("AfterReload");
  } catch (error) {
    checks.documentReload = { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  // A missing route replaces the area layout; the persistent root must reclaim window safety.
  const returnUrl = win.webContents.getURL();
  try {
    await win.loadURL(`${APP_ORIGIN}/__layout_smoke_missing__`);
    await check(
      "routeErrorSafety",
      `const until = Date.now() + 5000; while ((document.documentElement.dataset.hydrated !== "true" || !document.querySelector("main")?.textContent.includes("404")) && Date.now() < until) await new Promise((r) => setTimeout(r, 25)); const fallback = document.querySelector(".root-chrome-fallback"); const main = document.querySelector("main"); const native = navigator.windowControlsOverlay; const safe = native?.getTitlebarAreaRect(); const top = native?.visible ? safe.y + safe.height : 0; return { error: main?.textContent.includes("404"), shell: document.documentElement.dataset.shell, fallback: !!fallback, height: fallback?.getBoundingClientRect().height, contentTop: main?.getBoundingClientRect().top, safeTop: top };`,
      (v) =>
        isRecord(v) &&
        v.error === true &&
        v.shell === "desktop" &&
        v.fallback === true &&
        typeof v.height === "number" &&
        typeof v.contentTop === "number" &&
        typeof v.safeTop === "number" &&
        v.height >= v.safeTop - 1 &&
        v.contentTop >= v.safeTop - 1,
    );
    // Exercise the preload on a document without a shell appearance owner.
    const original = await js("return window.desktop.readVisual().record");
    const previous = records.decode(typeof original === "string" ? original : null).record;
    const dark = {
      version: 1 as const,
      stamp: records.nextStamp([previous]),
      preferences: { ...previous?.preferences, colorScheme: "dark" as const },
    };
    const darkRaw = records.encode(dark);
    await check(
      "visualMirrorDark",
      pushAndRead(darkRaw),
      (v) => isDurableMirror(v, darkRaw) && win.getBackgroundColor().toLowerCase().startsWith("#17191d"),
    );
    await check(
      "appearanceDoesNotChangeBackground",
      `const result = await window.desktop.declareOverlayAppearance({ owner: "smoke", revision: 1, appearance: {color: "#224466"} }); return { ...result, mode:window.desktop.bootstrap.mode };`,
      (v) =>
        isRecord(v) &&
        (process.platform === "darwin" || v.mode === "system-decorated"
          ? v.status === "unsupported"
          : v.status === "applied" && isRecord(v.appearance) && v.appearance.color === "#224466") &&
        win.getBackgroundColor().toLowerCase().startsWith("#17191d"),
    );
    await check(
      "appearanceRelease",
      `const result = await window.desktop.declareOverlayAppearance({owner: "smoke", revision: 2, appearance:null}); return { ...result, mode:window.desktop.bootstrap.mode };`,
      (v) =>
        isRecord(v) &&
        (process.platform === "darwin" || v.mode === "system-decorated"
          ? v.status === "unsupported"
          : v.status === "applied" && isRecord(v.appearance) && v.appearance.color === "#17191d"),
    );
    const restored = records.encode({
      version: 1,
      stamp: records.nextStamp([dark]),
      preferences: previous?.preferences ?? {},
    });
    await check("visualMirrorRestore", pushAndRead(restored), (v) => isDurableMirror(v, restored));

    await win.loadURL(returnUrl);
    await check("returnFromError", documentHydrationScript, (v) => v === true);
  } catch (error) {
    checks.routeErrorSafety = { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  // What the window shows at this point, for a human to look at.
  if (screenshot) {
    try {
      await writeFile(screenshot, (await win.capturePage()).toPNG());
      checks.screenshot = { ok: true, detail: screenshot };
    } catch (err) {
      checks.screenshot = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  win.webContents.off("console-message", onConsole);
  checks.rendererErrors = { ok: rendererErrors.length === 0, detail: rendererErrors };
  const ok = Object.values(checks).every((c) => c.ok);
  const skipped = Object.entries(checks)
    .filter(([, c]) => c.skipped)
    .map(([name]) => name);
  const result = {
    ok,
    suite: layout ? "template-layout" : "application",
    skipped,
    checks,
    bootProfile: profile.marks(),
    electron: process.versions.electron,
    node: process.versions.node,
  };
  process.stdout.write(`SMOKE_RESULT ${JSON.stringify(result)}\n`);
  log.info({ ok, skipped }, "smoke finished");
  return ok ? 0 : 1;
}

/**
 * Whether the `sse` check's first stream was delivered as a stream: every event and the closing
 * `end` event arrived, in order, spread over time (the first well before the stream ended, the
 * whole span at least half the server's), and the utility saw it complete, not abort.
 */
export function sseStreamed(
  v: Record<string, unknown>,
  { count, interval }: { count: number; interval: number },
): boolean {
  const { events, endMs, doneMs, server } = v;
  if (!Array.isArray(events) || events.length !== count || !events.every((e) => typeof e === "number")) return false;
  if (typeof endMs !== "number" || typeof doneMs !== "number") return false;
  const times = events;
  const span = (count - 1) * interval;
  const ordered = times.every((t, i) => i === 0 || t >= times[i - 1]);
  return (
    ordered &&
    times[times.length - 1] - times[0] >= span / 2 &&
    endMs - times[0] >= span / 2 &&
    doneMs >= endMs &&
    isRecord(server) &&
    server.completed === true &&
    server.aborted === false &&
    server.events === count
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validWindowState(value: unknown): boolean {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.revision) &&
    typeof value.focused === "boolean" &&
    typeof value.maximized === "boolean" &&
    typeof value.fullscreen === "boolean"
  );
}

const pushAndRead = (raw: string) =>
  `const result = await window.desktop.pushVisual(${JSON.stringify(raw)}); return { result, ...window.desktop.readVisual() };`;
const isDurableMirror = (value: unknown, raw: string) =>
  isRecord(value) && value.result === "ok" && value.record === raw && value.pending === false;
