import { useEffect, useState } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";

import type { Route } from "./+types/root";
import { CHROME_SAFETY_CSS } from "./layouts/app-shell/chrome-safety";
import { ContentScrollRestoration } from "./layouts/content-scroll-restoration";
import { cspNonceContext } from "./lib/csp";
import { desktopContext, shellContext } from "./lib/shell";
import { AppRoot } from "./providers/app-root";
import { useAppEnvironment } from "./providers/environment";

import "./app.css";

// No external stylesheets or fonts: the desktop shell loads pages offline, and an unreachable host
// would hold up the document (Google Fonts cost 4 s in the Electron spike). Self-host fonts if needed.
export const links: Route.LinksFunction = () => [];

/**
 * Initial host facts for AppRoot and the
 * document's Content-Security-Policy nonce for the inline scripts React Router emits (client and
 * server must render the same `nonce` prop, so it travels with the loader data). Allowed in both
 * rendering modes; in a SPA build it runs once at build time, so it always reports the web shell.
 */
export function loader({ context }: Route.LoaderArgs) {
  return {
    shell: context.get(shellContext),
    desktop: context.get(desktopContext),
    nonce: context.get(cspNonceContext),
  };
}

export function Layout({ children }: { children: React.ReactNode }) {
  // Undefined when the root loader failed and the ErrorBoundary renders in this Layout.
  const data = useRouteLoaderData<typeof loader>("root");
  const nonce = useCspNonce(data?.nonce);
  return (
    <AppRoot shell={data?.shell} mode={data?.desktop?.chromeMode} fullscreen={data?.desktop?.fullscreen}>
      <Document nonce={nonce}>{children}</Document>
    </AppRoot>
  );
}

function Document({ children, nonce }: { children: React.ReactNode; nonce?: string }) {
  const environment = useAppEnvironment();
  const { shell, fullscreen, windowState } = environment;
  useEffect(() => {
    // Evidence that the client bundle ran and hydration finished, for tests and the desktop smoke.
    document.documentElement.dataset.hydrated = "true";
  }, []);
  return (
    <html
      lang="en"
      data-shell={shell.kind}
      data-platform={shell.kind === "desktop" ? shell.platform : undefined}
      data-titlebar={
        shell.kind === "desktop" ? (environment.mode === "system-decorated" ? "native" : "custom") : undefined
      }
      data-chrome-mode={shell.kind === "desktop" ? environment.mode : undefined}
      data-chrome-enhancement={environment.enhancement}
      data-chrome-diagnostic={environment.diagnostic}
      data-chrome-diagnostic-fields={environment.diagnosticFields?.join(",")}
      data-fullscreen={
        windowState ? String(windowState.fullscreen) : fullscreen !== undefined ? String(fullscreen) : undefined
      }
    >
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style id="window-chrome-safety">{CHROME_SAFETY_CSS}</style>
        <Meta />
        <Links nonce={nonce} />
      </head>
      <body>
        <div className="root-frame">
          <div className="root-chrome-fallback" aria-hidden="true">
            <div className="window-safe-drag" data-window-drag="" />
          </div>
          <ContentScrollRestoration>{children}</ContentScrollRestoration>
        </div>
        <ScrollRestoration nonce={nonce} />
        <Scripts nonce={nonce} />
      </body>
    </html>
  );
}

/**
 * The document's CSP nonce, fixed for the life of the page: the one the root loader delivered, or,
 * on the client when there is no root loader data (the root ErrorBoundary rendering in this Layout),
 * the one on the document's scripts (the `nonce` property still reads it after browsers blank the
 * attribute). Later root revalidations carry a fresh nonce that must not replace it: the policy
 * header the document loaded with names the first one, and React would only rewrite attributes.
 */
function useCspNonce(fromLoader: string | undefined): string | undefined {
  const [nonce] = useState(
    () =>
      fromLoader ??
      (typeof document === "undefined"
        ? undefined
        : document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce || undefined),
  );
  return nonce;
}

export default function App() {
  return <Outlet />;
}

export function HydrateFallback() {
  return (
    <main className="p-4" aria-busy="true">
      Loading application…
    </main>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details = error.status === 404 ? "The requested page could not be found." : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="container mx-auto p-4 pt-16">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full overflow-x-auto p-4">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
