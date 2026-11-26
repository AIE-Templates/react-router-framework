import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, get, request as httpRequest, type RequestListener } from "node:http";
import { createSecureServer } from "node:http2";
import { createServer as createHttpsServer } from "node:https";
import type { Server } from "node:net";
import { join } from "node:path";

import { app, BrowserWindow, ipcMain, protocol, session, type Session } from "electron";

import {
  CookieStoreTimeoutError,
  createCookieJar,
  flushForQuit,
  installCookieIpc,
  installCookieWorkerIpc,
  stripCookieMarkers,
  type CookieIpcOptions,
} from "../../src/main.ts";
import { OMIT_COOKIES_HEADER } from "../../src/shared.ts";
import { workerControls } from "./worker-controls.ts";

const scheme = process.env.COOKIE_FIXTURE_SCHEME ?? "fixture";
const otherScheme = scheme + "-other";
const host = "app";
const origin = scheme + "://" + host;
const storageOrigin = "https://app.desktop";
const upstreamHost = process.env.COOKIE_FIXTURE_UPSTREAM_HOST ?? "127.0.0.1";
const nativeHost = "cookie.test";
const privileges = {
  standard: true,
  secure: true,
  allowServiceWorkers: true,
  supportFetchAPI: true,
  corsEnabled: true,
};
protocol.registerSchemesAsPrivileged([scheme, otherScheme].map((name) => ({ scheme: name, privileges })));
app.commandLine.appendSwitch("host-resolver-rules", "MAP " + nativeHost + " 127.0.0.1, MAP localhost 127.0.0.1");

export interface Reply {
  /** HTTP field bytes in Node's latin1 representation. */
  cookies: string[];
  date?: string;
}

const replies = new Map<string, Reply>();
const waitingResponses = new Map<string, () => void>();
const received = new Map<string, string>();
const markers = new Map<string, string | null>();
type WireRequest = { method: string; marker: string | null; preflightHeaders?: string };
const wire = new Map<string, WireRequest[]>();
const initiators = new Map<string, string | undefined>();
const pageHtml = "<!doctype html><title>Cookie fixture</title>";
const workerScript = readFileSync(new URL("./worker.mjs", import.meta.url));

const serviceWorkerScript = readFileSync(new URL("./service-worker.mjs", import.meta.url));

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
        "\r\nSet-Cookie: control-witness=ok; Path=/\r\n\r\n",
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
  if (req.method === "OPTIONS" && url.pathname === "/allow-omit-preflight") {
    res.setHeader("Access-Control-Allow-Headers", OMIT_COOKIES_HEADER);
  }
  if (key && !reply) {
    res.writeHead(404).end("Unknown reply");
    return;
  }
  if (key && reply) {
    const requests = wire.get(key) ?? [];
    const preflightHeaders = req.headers["access-control-request-headers"];
    requests.push({
      method: req.method ?? "",
      marker: req.headers[OMIT_COOKIES_HEADER]?.toString() ?? null,
      ...(preflightHeaders === undefined ? {} : { preflightHeaders }),
    });
    wire.set(key, requests);
    received.set(key, req.headers.cookie ?? "");
    res.setHeader("Set-Cookie", reply.cookies);
    if (reply.date) res.setHeader("Date", reply.date);
  }
  if (url.searchParams.has("status")) res.statusCode = Number(url.searchParams.get("status"));
  if (url.pathname === "/redirect") {
    const next = url.searchParams.get("next")!;
    const location = url.searchParams.has("absolute")
      ? new URL(next, ("encrypted" in req.socket ? "https://" : "http://") + req.headers.host).href
      : next;
    res.setHeader("Location", location);
    res.end();
  } else if (url.pathname === "/colliding-downgrades") {
    const pair = url.searchParams.get("pair");
    if (!pair) {
      res.writeHead(400).end("Missing response pair");
      return;
    }
    const finish = () => res.end(req.headers.cookie ?? "");
    const first = waitingResponses.get(pair);
    if (first) {
      waitingResponses.delete(pair);
      first();
      finish();
    } else {
      waitingResponses.set(pair, finish);
      res.once("close", () => {
        if (waitingResponses.get(pair) === finish) waitingResponses.delete(pair);
      });
    }
  } else if (url.pathname === "/inspect") {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const data = Buffer.concat(chunks);
      const type = req.headers["content-type"] ?? "";
      // Compare multipart fields, including duplicates, independently of the generated boundary.
      const body = type.startsWith("multipart/form-data")
        ? new Response(data, { headers: { "content-type": type } }).formData().then((form) => [...form])
        : Promise.resolve(data.toString());
      void body
        .then((value) => {
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          return res.end(
            JSON.stringify({
              method: req.method,
              cookie: req.headers.cookie ?? "",
              type: type.split(";")[0],
              body: value,
            }),
          );
        })
        .catch(() => res.writeHead(400).end("Invalid request body"));
    });
  } else if (url.pathname === "/pixel.gif") {
    res.setHeader("Content-Type", "image/gif");
    res.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"));
  } else if (url.pathname === "/subresource.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.end("document.documentElement.dataset.scriptLoaded = 'yes'");
  } else if (url.pathname === "/events") {
    res.setHeader("Content-Type", "text/event-stream");
    res.end("data: ready\n\n");
  } else if (url.pathname === "/__e2e/sandbox") {
    res.setHeader(
      "Content-Security-Policy",
      url.searchParams.has("sameOrigin") ? "sandbox allow-scripts allow-same-origin" : "sandbox allow-scripts",
    );
    res.setHeader("Content-Type", "text/html");
    res.end(pageHtml);
  } else if ((url.pathname === "/" || /\/page\/?$/.test(url.pathname)) && !key) {
    res.setHeader("Content-Type", "text/html");
    res.end(pageHtml);
  } else if (url.pathname === "/scripts/service-worker.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Service-Worker-Allowed", "/");
    res.end(serviceWorkerScript);
  } else if (url.pathname === "/worker.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.end(workerScript);
  } else if (url.pathname === "/module-worker.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.end('postMessage("ready")');
  } else if (url.pathname === "/manifest.webmanifest") {
    res.setHeader("Content-Type", "application/manifest+json");
    res.end(JSON.stringify({ name: "Credential comparison", start_url: "/" }));
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
  const tlsOptions = { key: readFileSync(join(tls, "key.pem")), cert: readFileSync(join(tls, "cert.pem")) };
  const https = createHttpsServer(tlsOptions, serve);
  const [port, tlsPort] = await Promise.all([listen(http), listen(https)]);
  const upstream = "http://127.0.0.1:" + port;
  const log = {
    debug() {},
    warn: (data: unknown, message: string) => process.stderr.write(message + " " + JSON.stringify(data) + "\n"),
  };
  const jar = createCookieJar({
    scheme,
    host,
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
      stripCookieMarkers(headers);
      headers.delete("host");
      headers.delete("cookie");
      const cookie = await jar.cookieHeader(cookieRequest, signal);
      signal.throwIfAborted();
      if (cookie !== undefined) headers.set("cookie", cookie);
      const target = upstream + url.pathname + url.search;
      const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
      const response = Object.hasOwn(malformedFields, url.pathname)
        ? await readMalformedResponse(target, headers, signal)
        : await fetch(target, {
            headers,
            signal,
            method: request.method,
            redirect: "manual",
            ...(hasBody ? { body: request.body, duplex: "half" } : {}),
          });
      await jar.storeResponseCookies(response.headers, cookieRequest);
      signal.throwIfAborted();
      const outgoing = new Headers(response.headers);
      outgoing.delete("set-cookie");
      const location = outgoing.get("location");
      if (location === upstream || location?.startsWith(upstream + "/"))
        outgoing.set("location", origin + location.slice(upstream.length));
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: outgoing,
      });
    } catch (error) {
      if (signal.aborted) return Response.error();
      if (error instanceof CookieStoreTimeoutError) return new Response(error.message, { status: 503 });
      throw error;
    }
  });
  const windows = new Map<Electron.WebContents, BrowserWindow>();
  const cookieOptions: CookieIpcOptions = {
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
  };
  installCookieIpc(cookieOptions);
  const workers = workerControls(ses, tls);
  const manager = installCookieWorkerIpc({ ...cookieOptions, ...workers.options });
  // Give the shared sandbox preload the configured app origin before worker evaluation.
  // A starting worker must not need a synchronous main-process handshake to install the shim.
  const preload = join(tls, "fixture-preload.cjs");
  writeFileSync(
    preload,
    '"use strict";\nconst fixtureAppOrigin = ' +
      JSON.stringify(origin) +
      ";\n" +
      readFileSync(join(import.meta.dirname, "preload.cjs"), "utf8"),
  );
  ses.registerPreloadScript({ type: "service-worker", filePath: preload });
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
        preload,
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
    workers: workers.controls,
    // Chromium requires HTTP/2 or later for a streaming upload. Reuse the exact HTTP/1 fixture routes.
    async openHttp2Origin() {
      const h2 = createSecureServer(tlsOptions, (req, res) => {
        const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !name.startsWith(":")));
        const forwarded = httpRequest(upstream + req.url, { method: req.method, headers }, (response) => {
          const {
            connection: _connection,
            "keep-alive": _keepAlive,
            "transfer-encoding": _transfer,
            ...fields
          } = response.headers;
          res.writeHead(response.statusCode ?? 500, fields);
          response.pipe(res);
        });
        forwarded.on("error", () => res.destroy());
        req.pipe(forwarded);
      });
      return "https://" + nativeHost + ":" + (await listen(h2));
    },
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
    void Promise.all([manager.quitAll(), flushForQuit(ses.cookies, log)]).finally(() => app.quit());
  });
  await openWindow(origin + "/");
}

declare global {
  var cookieFixture: {
    workers: ReturnType<typeof workerControls>["controls"];
    openWindow(url: string): Promise<void>;
    openHttp2Origin(): Promise<string>;
    opaqueSteps: unknown[];
    preloadErrors: string[];
    probeOpaque(url: string): { origin: string; preloadStarted: boolean };
    pushes: number[];
    network(path: string): { marker?: string | null; wire: WireRequest[] };
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
