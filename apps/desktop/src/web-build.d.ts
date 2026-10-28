/**
 * The web app's server build, as the desktop shell uses it. Typed by hand (not from apps/web's
 * sources, whose own path aliases and virtual modules do not resolve from here) so the shell stays
 * decoupled from the web app's internals.
 */
declare module "web/build/server/index.js" {
  export function createWebApp(options?: {
    clientDir?: string;
    ssr?: boolean;
    shell?: import("@repo/shared").Shell;
    extend?: (app: import("hono").Hono) => void;
  }): {
    fetch(request: Request): Response | Promise<Response>;
  };
  export const rethrowNonErrors: import("./smoke-routes.ts").StreamHelpers["rethrowNonErrors"];
  export const logStreamFailure: import("./smoke-routes.ts").StreamHelpers["logStreamFailure"];
}
