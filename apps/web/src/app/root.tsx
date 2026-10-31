import { useEffect } from "react";
import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

import type { Route } from "./+types/root";
import { CHROME_SAFETY_CSS } from "./layouts/app-shell/chrome-safety";
import { ContentScrollRestoration } from "./layouts/content-scroll-restoration";
import { visualServerAttributes } from "./managers/visual/bootstrap";
import { useVisualManager } from "./managers/visual/hooks";
import { VisualInitScript } from "./managers/visual/init-script";
import { AppRoot } from "./providers/app-root";
import { AppUiProvider } from "./providers/app-ui-provider";
import { useAppEnvironment } from "./providers/environment";

import "./app.css";

// No external stylesheets or fonts: pages may load offline (a desktop shell, an intranet), and an
// unreachable host would hold up the document. Self-host fonts if needed.
export const links: Route.LinksFunction = () => [];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <AppRoot>
      <Document>{children}</Document>
    </AppRoot>
  );
}

function Document({ children }: { children: React.ReactNode }) {
  const environment = useAppEnvironment();
  const visual = useVisualManager().getServerSnapshot().preferences;
  const { shell, fullscreen, windowState } = environment;
  useEffect(() => {
    // Evidence that the client bundle ran and hydration finished, for tests and smoke checks.
    document.documentElement.dataset.hydrated = "true";
  }, []);
  return (
    <html
      lang="en"
      suppressHydrationWarning
      {...visualServerAttributes(visual.colorScheme)}
      dir={visual.direction}
      data-color-scheme={visual.colorScheme === "auto" ? undefined : visual.colorScheme}
      data-reduced-motion={visual.reducedMotion === "auto" ? undefined : visual.reducedMotion}
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
        <VisualInitScript />
        <Meta />
        <Links />
      </head>
      <body>
        <AppUiProvider>
          <div className="root-frame">
            <div className="root-chrome-fallback" aria-hidden="true">
              <div className="window-safe-drag" data-window-drag="" />
            </div>
            <ContentScrollRestoration>{children}</ContentScrollRestoration>
          </div>
        </AppUiProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
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
