import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";

import { getRequestListener } from "@hono/node-server";
import type { Logger } from "pino";

import { logger as defaultLogger, logStreamErrors } from "./logger.ts";
import { withForwardedOrigin } from "./proxy.ts";

export interface StartServerOptions {
  /** The address to listen on. Defaults to `HOST`, then `0.0.0.0`. */
  host?: string;
  /** The port to listen on. Defaults to `PORT`, then `3000`; `0` picks a free one. */
  port?: number | string;
  /**
   * Take each request's scheme and host from X-Forwarded-Proto/-Host, behind a reverse proxy that
   * terminates TLS, so origin checks see the URL the browser used. Defaults to `TRUST_PROXY=true`.
   * Only enable it when a proxy sets these headers: clients reaching the server directly could forge them.
   */
  trustProxy?: boolean;
  /** Logs startup and shutdown, and errors while streaming responses. Defaults to the package's logger. */
  logger?: Logger;
  /** How long in-flight requests get to finish on shutdown. Defaults to 8 seconds, below Docker's 10 second stop timeout. */
  shutdownTimeoutMs?: number;
  /**
   * Shut down on SIGTERM and SIGINT, then exit, once the server is listening. Every server started
   * with it in the process is closed before exiting. Defaults to `true`.
   */
  handleSignals?: boolean;
}

export interface RunningServer {
  httpServer: Server;
  /** The URL the server listens on, from the actual address. */
  url: string;
  /**
   * Stops accepting connections and lets in-flight requests finish, within the shutdown timeout.
   * Responses sent meanwhile tell clients to close keep-alive connections, which are closed once idle.
   */
  close(): Promise<void>;
}

/**
 * Serves `app` over HTTP on Node.js, with graceful shutdown. Errors while streaming a response body
 * are logged with the request ID and drop the connection, so the client sees an incomplete response.
 * Resolves once the server is listening.
 */
export function startServer(
  app: { fetch: (request: Request) => Response | Promise<Response> },
  {
    host = process.env.HOST || "0.0.0.0",
    port = process.env.PORT || "3000",
    trustProxy = process.env.TRUST_PROXY === "true",
    logger = defaultLogger,
    shutdownTimeoutMs = 8000,
    handleSignals = true,
  }: StartServerOptions = {},
): Promise<RunningServer> {
  // Startup and shutdown are logged even when the level hides `info` (production defaults to `warn`),
  // so it is clear the server is up, unless logging is silenced.
  const lifecycle =
    logger.isLevelEnabled("info") || logger.level === "silent" ? logger : logger.child({}, { level: "info" });

  // Keep the native Request/Response globals: the lighter replacements break `instanceof Request`
  // after `request.clone()`, which is not worth the small speedup.
  const handle = getRequestListener(
    async (request: Request, env) => {
      const response = await app.fetch(trustProxy ? withForwardedOrigin(request) : request);
      return logStreamErrors(response, () => env.outgoing.destroy(), logger);
    },
    { overrideGlobalObjects: false },
  );

  // Open sockets, and those with a request in flight. The rest are idle, including sockets that never
  // sent a request (e.g. a browser preconnect), which httpServer.closeIdleConnections() leaves open.
  const sockets = new Set<Socket>();
  // Requests in flight per socket: a count, since a client may pipeline several on one socket.
  const inFlight = new WeakMap<Socket, number>();
  const closeIdleSockets = () => {
    for (const socket of sockets) if (!inFlight.get(socket)) socket.destroy();
  };

  let shuttingDown = false;
  const httpServer = createServer((req, res) => {
    const { socket } = req;
    inFlight.set(socket, (inFlight.get(socket) ?? 0) + 1);
    if (shuttingDown) res.setHeader("Connection", "close");
    res.on("close", () => {
      inFlight.set(socket, (inFlight.get(socket) ?? 1) - 1);
      // Close keep-alive connections as soon as their in-flight request is done.
      if (shuttingDown) closeIdleSockets();
    });
    void handle(req, res);
  });
  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= new Promise<void>((resolve) => {
      shuttingDown = true;
      signalled.delete(running);
      const timeout = setTimeout(() => {
        lifecycle.warn("Shutdown timed out, closing open connections");
        httpServer.closeAllConnections();
      }, shutdownTimeoutMs);
      timeout.unref();
      httpServer.close(() => {
        clearTimeout(timeout);
        resolve();
      });
      closeIdleSockets();
    }));
  const running: SignalledServer = { close, logger, lifecycle };

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(parsePort(port), host, () => {
      httpServer.off("error", reject);
      // Errors after startup (rare: the listening socket failing) would otherwise be uncaught
      // exceptions, crashing the process without a log line.
      httpServer.on("error", (err) => logger.error({ err }, "server error"));
      const url = serverUrl(httpServer.address());
      lifecycle.info(`Server is running on ${url}`);
      // Only now: a server that failed to start has nothing to shut down.
      if (handleSignals) handleSignalsFor(running);
      resolve({ httpServer, url, close });
    });
  });
}

interface SignalledServer {
  close(): Promise<void>;
  logger: Logger;
  lifecycle: Logger;
}

/** The servers to close on SIGTERM/SIGINT, in this process. */
const signalled = new Set<SignalledServer>();
let signalHandlersInstalled = false;
/** The shutdown in progress, once a signal arrived, and the loggers it reports to. */
let exiting: { done: Promise<void>; lifecycles: Set<Logger> } | undefined;

/**
 * Closes `server` on SIGTERM/SIGINT, then exits. The handlers are installed once per process and
 * close every server registered by then, so two servers in one process don't exit on the first
 * one to finish closing. A signal of the other kind during the shutdown waits for it; `once`, so a
 * second signal of the same kind ends the process at once.
 */
function handleSignalsFor(server: SignalledServer): void {
  signalled.add(server);
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  const shutdown = (signal: NodeJS.Signals) => {
    // Servers may share a logger (the default one): log and flush once per logger.
    const servers = [...signalled];
    exiting ??= {
      lifecycles: new Set(servers.map((s) => s.lifecycle)),
      done: Promise.all(servers.map((s) => s.close())).then(() => {
        for (const logger of new Set(servers.map((s) => s.logger))) logger.flush();
        process.exit(0);
      }),
    };
    for (const lifecycle of exiting.lifecycles) lifecycle.info(`Received ${signal}, shutting down`);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

function parsePort(value: number | string): number {
  const port = Number(value);
  if (!/^\d+$/.test(String(value)) || port > 65_535)
    throw new Error(`Invalid PORT "${value}": expected an integer from 0 to 65535`);
  return port;
}

/** The URL to print at startup, from the actual address (PORT=0 picks a free port). */
function serverUrl(address: ReturnType<Server["address"]>): string {
  if (!address || typeof address === "string") return String(address);
  const host = ["0.0.0.0", "::"].includes(address.address)
    ? "localhost"
    : address.family === "IPv6"
      ? `[${address.address}]`
      : address.address;
  return `http://${host}:${address.port}`;
}
