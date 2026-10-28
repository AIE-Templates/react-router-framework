// Run with Electron, not Node: pnpm --filter desktop exec electron scripts/wco-probe.cjs
// A standalone validation probe. It does not change the app's supported-platform policy.
const { app, BrowserWindow, protocol } = require("electron");

const decorated = process.argv.includes("--system-decorated");
const macOverlayHeight = 48;
const metadata = {
  mode: decorated ? "system-decorated" : "native-overlay",
  platform: process.platform,
  arch: process.arch,
  os: process.getSystemVersion(),
  electron: process.versions.electron,
  documentScripts: "blocked-by-csp",
};
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0}.bar{height:calc(env(titlebar-area-y,0px) + env(titlebar-area-height,0px));flex-shrink:0}
.drag{margin-left:env(titlebar-area-x,0px);width:env(titlebar-area-width,100%);height:env(titlebar-area-height,0px);app-region:drag}
</style></head><body><div class="bar"><div class="drag"></div></div><main>Window controls must stay above this content.</main></body></html>`;

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function afterEvent(emitter, name, action) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      emitter.off(name, done);
      reject(new Error(`Timed out waiting for ${name}`));
    }, 4000);
    function done() {
      clearTimeout(timeout);
      resolve();
    }
    emitter.once(name, done);
    void Promise.resolve()
      .then(action)
      .catch((error) => {
        clearTimeout(timeout);
        emitter.off(name, done);
        reject(error);
      });
  });
}

async function measure(win, label, fullscreen = false) {
  // This diagnostic runs from main; the document itself has no preload or executable scripts.
  const result = await win.webContents.executeJavaScript(`(() => {
    const rect = (selector) => document.querySelector(selector).getBoundingClientRect().toJSON();
    const overlay = navigator.windowControlsOverlay;
    return { bar: rect('.bar'), drag: rect('.drag'), main: rect('main'),
      wco: overlay ? overlay.getTitlebarAreaRect().toJSON() : null, visible: overlay?.visible ?? false };
  })()`);
  const buttonPosition = process.platform === "darwin" ? win.getWindowButtonPosition() : null;
  process.stdout.write(
    `${JSON.stringify({ label, ...metadata, zoom: win.webContents.getZoomFactor(), buttonPosition, ...result })}\n`,
  );
  if (buttonPosition !== null) throw new Error(`${label}: custom button coordinates disable native centering`);
  if (result.main.y < result.bar.bottom) throw new Error(`${label}: content overlaps the safety bar`);
  if (decorated || fullscreen) {
    if (result.bar.height !== 0 || result.visible) throw new Error(`${label}: unexpected window-controls occupancy`);
  } else {
    if (!result.visible || result.bar.height <= 0 || result.drag.height <= 0 || result.drag.width <= 0)
      throw new Error(`${label}: visible controls have no first-frame CSS safety region`);
    if (
      process.platform === "darwin" &&
      result.bar.height !== Math.ceil(macOverlayHeight / win.webContents.getZoomFactor())
    )
      throw new Error(`${label}: native overlay height does not match zoom-adjusted header`);
  }
}

async function probe() {
  protocol.handle(
    "app",
    () =>
      new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'",
        },
      }),
  );
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 700,
    ...(!decorated
      ? {
          titleBarStyle: "hidden",
          // Let Electron center the real native button frames; never supply guessed traffic-light y.
          titleBarOverlay: process.platform === "darwin" ? { height: macOverlayHeight } : true,
        }
      : {}),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const firstPaint = afterEvent(win, "ready-to-show", () => win.loadURL("app://app/"));
  await firstPaint;
  await measure(win, "ready-to-show");
  win.show();
  await measure(win, "shown");
  for (const zoom of [0.8, 1.25, 1]) {
    win.webContents.setZoomFactor(zoom);
    await delay(150);
    await measure(win, `zoom-${zoom}`);
  }
  await afterEvent(win.webContents, "did-finish-load", () => win.webContents.reload());
  await measure(win, "visible-reload");
  await afterEvent(win, "enter-full-screen", () => win.setFullScreen(true));
  await delay(300);
  await measure(win, "fullscreen", true);
  await afterEvent(win, "leave-full-screen", () => win.setFullScreen(false));
  await delay(300);
  await measure(win, "leave-fullscreen");
  await afterEvent(win.webContents, "render-process-gone", () => win.webContents.forcefullyCrashRenderer());
  await win.loadURL("app://app/");
  await measure(win, "renderer-crash-reload");
  process.stdout.write(`${JSON.stringify({ label: "WCO_PROBE_RESULT", ...metadata, ok: true })}\n`);
}

const watchdog = setTimeout(() => {
  process.stderr.write("WCO probe exceeded 20 seconds\n");
  app.exit(2);
}, 20_000);
app
  .whenReady()
  .then(probe)
  .then(() => {
    clearTimeout(watchdog);
    app.exit(0);
    return undefined;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    app.exit(1);
  });
