import { useState } from "react";
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
import { cspNonceContext } from "./lib/csp";

import "./app.css";

// No external stylesheets or fonts: pages may load offline (a desktop shell, an intranet), and an
// unreachable host would hold up the document. Self-host fonts if needed.
export const links: Route.LinksFunction = () => [];

/**
 * The document's Content-Security-Policy nonce for the inline scripts React Router emits (client and
 * server must render the same `nonce` prop, so it travels with the loader data). Allowed in both
 * rendering modes; in a SPA build it runs once at build time.
 */
export function loader({ context }: Route.LoaderArgs) {
  return {
    nonce: context.get(cspNonceContext),
  };
}

export function Layout({ children }: { children: React.ReactNode }) {
  // Undefined when the root loader failed and the ErrorBoundary renders in this Layout.
  const data = useRouteLoaderData<typeof loader>("root");
  const nonce = useCspNonce(data?.nonce);
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links nonce={nonce} />
      </head>
      <body>
        {children}
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
