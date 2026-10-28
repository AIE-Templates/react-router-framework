import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { getRequestListener } from "@hono/node-server";
import { isRunnableDevEnvironment, type Plugin } from "vite";

type AppModule = typeof import("./app.ts");

/**
 * Serves the Hono app from Vite, so API routes, Hono middleware and the React Router context set in
 * src/host/app.ts are the same as in server.ts:
 * - in `react-router dev`, while Vite keeps its own server, CLI options and HMR;
 * - while `react-router build` prerenders, which otherwise bypasses the app.
 */
export function honoServer({ entry = "./src/host/app.ts", buildFile = "build/server/index.js" } = {}): Plugin {
  return {
    name: "hono-server",
    configureServer(server) {
      const ssr = server.environments.ssr;
      if (!ssr || !isRunnableDevEnvironment(ssr)) throw new Error("Vite SSR environment is not runnable");

      // Import through Vite's module runner on every request, so server code changes apply
      // without a restart and stack traces map back to the source.
      const handle = getRequestListener(
        async (request, env) => {
          const { getHostApp, logStreamErrors } = await ssr.runner.import<AppModule>(entry);
          return logStreamErrors(await getHostApp().fetch(request), () => env.outgoing.destroy());
        },
        // Keep Vite's process on the native Request/Response globals.
        { overrideGlobalObjects: false },
      );

      // Returning a function registers the middleware after Vite's internal ones, so module,
      // `/@vite/*` and public file requests are already handled by the time a request gets here.
      return () => {
        server.middlewares.use((req, res) => {
          // Chrome DevTools probes this path on every page load; keep it out of React Router.
          if (req.url === "/.well-known/appspecific/com.chrome.devtools.json") {
            res.statusCode = 404;
            res.end();
            return;
          }
          // getRequestListener catches errors itself, logging them and responding with a 500.
          void handle(req, res);
        });
      };
    },
    configurePreviewServer(server) {
      // React Router prerenders through a preview server with its own request handler, which would
      // leave loaders without the context src/host/app.ts sets. Only take over during that build.
      if (process.env.IS_RR_BUILD_REQUEST !== "yes") return;

      const buildUrl = pathToFileURL(resolve(server.config.root, buildFile)).href;
      const handle = getRequestListener(
        async (request) => {
          const { getHostApp }: typeof import("./index.ts") = await import(buildUrl);
          return getHostApp().fetch(request);
        },
        { overrideGlobalObjects: false },
      );
      // Registered before React Router's own preview middleware.
      server.middlewares.use((req, res) => void handle(req, res));
    },
  };
}
