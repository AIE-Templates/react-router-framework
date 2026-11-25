import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, get, type RequestListener, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";

import { app, BrowserWindow, ipcMain, protocol, session, type Session } from "electron";

import { CookieStoreTimeoutError, createCookieJar, flushForQuit, installCookieIpc } from "../../src/main.ts";
import { OMIT_COOKIES_HEADER } from "../../src/shared.ts";

const scheme = process.env.COOKIE_FIXTURE_SCHEME ?? "fixture";
const otherScheme = scheme + "-other";
const host = "app";
const origin = scheme + "://" + host;
const storageOrigin = "https://app.desktop";
const upstreamHost = process.env.COOKIE_FIXTURE_UPSTREAM_HOST ?? "127.0.0.1";
const nativeHost = "cookie.test";
const privileges = { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true };
protocol.registerSchemesAsPrivileged([scheme, otherScheme].map((name) => ({ scheme: name, privileges })));
app.commandLine.appendSwitch("host-resolver-rules", "MAP " + nativeHost + " 127.0.0.1, MAP localhost 127.0.0.1");

export interface Reply {
  /** HTTP field bytes in Node's latin1 representation. */
  cookies: string[];
  date?: string;
}

const replies = new Map<string, Reply>();
const received = new Map<string, string>();
const markers = new Map<string, string | null>();
const wire = new Map<string, { method: string; marker: string | null }[]>();
const initiators = new Map<string, string | undefined>();
const pageHtml = "<!doctype html><title>Cookie fixture</title>";
const workerScript = readFileSync(new URL("./worker.mjs", import.meta.url));

// These fixed fields cannot be emitted with Node's validated setHeader(). Chromium may
// reject the entire HTTP response before its cookie parser sees them.
const malformedFields: Record<string, string> = {
  "/control-in-path": "ctlpath=bad; Path=/a\x01b",
  "/control-in-extension": "ctlext=bad; Unknown=a\x7fb",
};

const serve: RequestListener = (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (Object.hasOwn(malformedFields, url.pathname)) {
    req.socket.end(
      "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\nSet-Cookie: " +
        malformedFields[url.pathname] +
        "\r\n\r\n",
      "latin1",
    );
    return;
  }
  const key = url.searchParams.get("reply");
  const reply = key && replies.get(key);
  res.setHeader("Cache-Control", "no-store");
  if (req.headers.origin) {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  if (key && !reply) {
    res.writeHead(404).end("Unknown reply");
    return;
  }
  if (key && reply) {
    const requests = wire.get(key) ?? [];
    requests.push({ method: req.method ?? "", marker: req.headers[OMIT_COOKIES_HEADER]?.toString() ?? null });
    wire.set(key, requests);
    received.set(key, req.headers.cookie ?? "");
    res.setHeader("Set-Cookie", reply.cookies);
    if (reply.date) res.setHeader("Date", reply.date);
  }
  if (url.pathname === "/__e2e/sandbox") {
    res.setHeader("Content-Security-Policy", "sandbox allow-scripts");
    res.setHeader("Content-Type", "text/html");
    res.end(pageHtml);
  } else if ((url.pathname === "/" || /\/page\/?$/.test(url.pathname)) && !key) {
    res.setHeader("Content-Type", "text/html");
    res.end(pageHtml);
  } else if (url.pathname === "/worker.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.end(workerScript);
  } else {
    // Returning the latin1 representation as UTF-8 text preserves every byte for Playwright.
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(Buffer.from(req.headers.cookie ?? "", "utf8"));
  }
};

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback port");
  return address.port;
}

// Only these two malformed-field fixtures need a lenient HTTP reader. Pass the actual
// response field bytes to the same Headers / jar boundary as a normal upstream response.
async function readMalformedResponse(url: string, requestHeaders: Headers, signal: AbortSignal) {
  return new Promise<Response>((resolve, reject) => {
    get(url, { headers: Object.fromEntries(requestHeaders), insecureHTTPParser: true, signal }, (res) => {
      const headers = new Headers();
      for (const line of res.headers["set-cookie"] ?? []) headers.append("set-cookie", line);
      res
        .resume()
        .once("end", () => resolve(new Response(null, { headers })))
        .once("error", reject);
    }).once("error", reject);
  });
}

function denyPermissions(ses: Session) {
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
}

async function start() {
  const ses = session.defaultSession;
  denyPermissions(ses);
  const tls = app.getPath("userData");
  const http = createServer(serve);
  let socketCookie: string | undefined;
  http.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key || req.url !== "/hmr") {
      socket.destroy();
      return;
    }
    socketCookie = req.headers.cookie ?? "";
    const accept = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: " +
        accept +
        "\r\n\r\n",
    );
    socket.end(Buffer.from([0x88, 0]));
  });
  const https = createHttpsServer(
    { key: readFileSync(join(tls, "key.pem")), cert: readFileSync(join(tls, "cert.pem")) },
    serve,
  );
  const [port, tlsPort] = await Promise.all([listen(http), listen(https)]);
  const upstream = "http://127.0.0.1:" + port;
  const log = {
    debug() {},
    warn: (data: unknown, message: string) => process.stderr.write(message + " " + JSON.stringify(data) + "\n"),
  };
  const jar = createCookieJar({
    scheme,
    host,
    origin,
    storageOrigin,
    upstreamHost,
    store: ses.cookies,
    fromPartition: (partition) => session.fromPartition(partition),
    installPermissionPolicy: denyPermissions,
    log,
  });
  ses.protocol.handle(otherScheme, () => new Response(pageHtml, { headers: { "content-type": "text/html" } }));
  ses.protocol.handle(scheme, async (request: Request & { initiatorOrigin?: string }) => {
    const url = new URL(request.url);
    if (url.host !== host) return new Response(null, { status: 404 });
    const { signal } = request;
    const key = url.searchParams.get("reply");
    if (key) {
      initiators.set(key, request.initiatorOrigin);
      markers.set(key, request.headers.get(OMIT_COOKIES_HEADER));
    }
    const cookieRequest = { path: url.pathname, headers: request.headers, initiatorOrigin: request.initiatorOrigin };
    try {
      const headers = new Headers(request.headers);
      headers.delete(OMIT_COOKIES_HEADER);
      headers.delete("host");
      headers.delete("cookie");
      const cookie = await jar.cookieHeader(cookieRequest, signal);
      signal.throwIfAborted();
      if (cookie !== undefined) headers.set("cookie", cookie);
      const target = upstream + url.pathname + url.search;
      const response = Object.hasOwn(malformedFields, url.pathname)
        ? await readMalformedResponse(target, headers, signal)
        : await fetch(target, { headers, signal });
      await jar.storeResponseCookies(response.headers, cookieRequest);
      signal.throwIfAborted();
      const outgoing = new Headers(response.headers);
      outgoing.delete("set-cookie");
      return new Response(response.body, { status: response.status, headers: outgoing });
    } catch (error) {
      if (signal.aborted) return Response.error();
      if (error instanceof CookieStoreTimeoutError) return new Response(error.message, { status: 503 });
      throw error;
    }
  });
  const windows = new Map<Electron.WebContents, BrowserWindow>();
  installCookieIpc({
    prefix: "fixture",
    jar,
    ipcMain,
    changes: ses.cookies,
    log,
    ownsSender: (sender) => sender.session === ses && windows.has(sender),
    isAppUrl: (url) => {
      const target = URL.parse(url);
      return target?.protocol === scheme + ":" && target.host === host;
    },
  });
  const startedPreloads = new Set<string>();
  ipcMain.on("fixture:origin", (event) => {
    if (event.senderFrame) startedPreloads.add(event.senderFrame.frameToken);
    event.returnValue = origin;
  });
  const preloadErrors: string[] = [];
  const openWindow = async (url: string) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegrationInSubFrames: true,
        preload: join(import.meta.dirname, "preload.cjs"),
      },
    });
    const contents = win.webContents;
    contents.on("preload-error", (_event, _path, err) => preloadErrors.push(err.message));
    windows.set(contents, win);
    win.once("closed", () => windows.delete(contents));
    await win.loadURL(url);
  };
  const opaqueSteps: unknown[] = [];
  const pushes: number[] = [];
  ipcMain.on("fixture:push-observed", (event) => pushes.push(event.sender.id));
  globalThis.cookieFixture = {
    openWindow,
    opaqueSteps,
    preloadErrors,
    probeOpaque(url: string) {
      const contents = [...windows.keys()].find((w) => w.mainFrame.origin === origin);
      const frame = contents?.mainFrame.frames.find((f) => f.name === "opaque-cookie-probe" && f.url === url);
      if (!frame) throw new Error("Missing named child frame for " + url);
      // Only this live document can supply observations for this probe.
      frame.ipc.on("fixture:opaque-step", (_event, step: unknown) => opaqueSteps.push(step));
      frame.send("fixture:probe-opaque");
      return { origin: frame.origin, preloadStarted: startedPreloads.has(frame.frameToken) };
    },
    pushes,
    network(path) {
      const key = new URL(path, origin).searchParams.get("reply") ?? "";
      return { marker: markers.get(key), wire: wire.get(key) ?? [] };
    },
    origins: { jar: origin, localhost: "http://localhost:" + port, https: "https://" + nativeHost + ":" + tlsPort },
    storageOrigin,
    otherOrigin: otherScheme + "://" + host,
    websocket: "ws://127.0.0.1:" + port + "/hmr",
    socketCookie: () => socketCookie,
    observation(path) {
      const key = new URL(path, origin).searchParams.get("reply") ?? "";
      return {
        reached: received.has(key) && initiators.has(key),
        cookie: received.get(key),
        initiator: initiators.get(key),
      };
    },
    addReply(reply: Reply) {
      const id = randomUUID();
      replies.set(id, reply);
      return id;
    },
  };
  app.once("will-quit", (event) => {
    event.preventDefault();
    void flushForQuit(ses.cookies, log).finally(() => app.quit());
  });
  await openWindow(origin + "/");
}

declare global {
  var cookieFixture: {
    openWindow(url: string): Promise<void>;
    opaqueSteps: unknown[];
    preloadErrors: string[];
    probeOpaque(url: string): { origin: string; preloadStarted: boolean };
    pushes: number[];
    network(path: string): { marker?: string | null; wire: { method: string; marker: string | null }[] };
    origins: Record<"jar" | "localhost" | "https", string>;
    storageOrigin: string;
    otherOrigin: string;
    websocket: string;
    socketCookie(): string | undefined;
    observation(path: string): { reached: boolean; cookie?: string; initiator?: string };
    addReply(reply: Reply): string;
  };
}

app
  .whenReady()
  .then(start)
  .catch((error: unknown) => {
    process.stderr.write(String(error) + "\n");
    app.exit(1);
  });
