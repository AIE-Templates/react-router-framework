import { PassThrough } from "node:stream";

import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import type { RenderToPipeableStreamOptions } from "react-dom/server";
import { renderToPipeableStream } from "react-dom/server";
import type { EntryContext, HandleErrorFunction, RouterContextProvider } from "react-router";
import { isRouteErrorResponse, ServerRouter } from "react-router";

import { cspNonceContext } from "~/lib/csp";
import { loggerContext } from "~/lib/logger";
import { DocumentNonceContext } from "~/providers/document-nonce";

// React Router's default Node entry (@react-router/dev/dist/config/defaults/entry.server.node.tsx),
// changed to log errors with the request's logger, so they carry its requestId, including render
// errors that happen before the response starts. Keep it in sync with the default when upgrading
// React Router.

export const streamTimeout = 5_000;

/**
 * Logs errors from loaders, actions and rendering. Skips aborted requests (e.g. the user navigated
 * away) and 4xx responses such as unmatched URLs, which the request log already records as info.
 */
export const handleError: HandleErrorFunction = (error, { request, context }) => {
  if (request.signal.aborted || (isRouteErrorResponse(error) && error.status < 500)) return;
  // React Router rejects actions submitted from another origin with a plain Error (400). That is
  // the client's doing, which anyone can trigger, so log it as a warning without the stack.
  if (isCrossOriginMutation(request)) {
    const origin = request.headers.get("origin");
    context.get(loggerContext).warn({ path: new URL(request.url).pathname, origin }, "cross-origin action rejected");
    return;
  }
  context.get(loggerContext).error({ err: error, path: new URL(request.url).pathname }, "unhandled error");
};

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider,
) {
  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  const logRenderError = (error: unknown) =>
    loadContext.get(loggerContext).error({ err: error }, "streaming render error");
  // The host's Content-Security-Policy nonce: <ServerRouter> puts it on the scripts that stream
  // loader data, React on the scripts it streams for Suspense boundaries. The components in
  // root.tsx (<Links>, <Scripts>, <ScrollRestoration>) get it explicitly from the root loader, so
  // the client renders the same `nonce` prop and hydration matches.
  const nonce = loadContext.get(cspNonceContext);

  return new Promise((resolve, reject) => {
    let shellRendered = false;
    // Errors before the response starts, e.g. rejected deferred data when bots and SPA mode wait for
    // everything (onAllReady). Logged once the response starts; a failed shell is logged by
    // handleError instead.
    const earlyErrors: unknown[] = [];
    let userAgent = request.headers.get("user-agent");

    // Ensure requests from bots and SPA Mode renders wait for all content to load before responding
    // https://react.dev/reference/react-dom/server/renderToPipeableStream#waiting-for-all-content-to-load-for-crawlers-and-static-generation
    let readyOption: keyof RenderToPipeableStreamOptions =
      (userAgent && isbot(userAgent)) || routerContext.isSpaMode ? "onAllReady" : "onShellReady";

    // Abort the rendering stream after the `streamTimeout` so it has time to
    // flush down the rejected boundaries
    let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(() => abort(), streamTimeout + 1000);

    const { pipe, abort } = renderToPipeableStream(
      <DocumentNonceContext.Provider value={nonce}>
        <ServerRouter context={routerContext} url={request.url} nonce={nonce} />
      </DocumentNonceContext.Provider>,
      {
        nonce,
        [readyOption]() {
          shellRendered = true;
          for (const error of earlyErrors) logRenderError(error);
          const body = new PassThrough({
            final(callback) {
              // Clear the timeout to prevent retaining the closure and memory leak
              clearTimeout(timeoutId);
              timeoutId = undefined;
              callback();
            },
          });
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");

          pipe(body);

          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          // Skip errors from aborted requests (the user navigated away). Errors before the response
          // starts wait in earlyErrors: if the shell fails, onShellError rejects and handleError logs it.
          if (request.signal.aborted) return;
          if (shellRendered) logRenderError(error);
          else earlyErrors.push(error);
        },
      },
    );
  });
}

function isCrossOriginMutation(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || request.method === "GET" || request.method === "HEAD") return false;
  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    return true; // e.g. Origin: null
  }
}
