import { createHash, randomBytes } from "node:crypto";

import type { MiddlewareHandler } from "hono";

declare module "hono" {
  interface ContextVariableMap {
    /** The nonce the document's inline scripts must carry; set by `cspMiddleware()` on every request. */
    cspNonce: string;
  }
}

/** Content-Security-Policy directives and their sources, e.g. `{ "script-src": ["'self'"] }`. */
export type ContentSecurityPolicy = Record<string, string[]>;

/**
 * The default policy: everything same-origin, inline scripts only with the document's nonce (or,
 * for prebuilt pages, their hash), inline styles allowed (Tailwind and React style attributes),
 * no plugins, no framing. `'self'` is the document's origin, so the same policy serves the web
 * deployment and the desktop shell's `app://app`.
 *
 * In development the Vite client and React Refresh inject inline scripts without a nonce, and HMR
 * needs a WebSocket, so scripts are `'unsafe-inline'` (a nonce would make browsers ignore it) and
 * `ws:` is allowed. Never ship the development policy.
 */
export function defaultPolicy(development = import.meta.env.DEV): ContentSecurityPolicy {
  return {
    "default-src": ["'self'"],
    "script-src": development ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "connect-src": development ? ["'self'", "ws:", "wss:"] : ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "frame-ancestors": ["'none'"],
    "form-action": ["'self'"],
  };
}

/** The header value, with `scriptSources` (a nonce or hashes) added to `script-src`. */
export function serializePolicy(policy: ContentSecurityPolicy, scriptSources: string[] = []): string {
  return Object.entries(policy)
    .map(([directive, sources]) => {
      const all = directive === "script-src" ? [...sources, ...scriptSources] : sources;
      return all.length ? `${directive} ${all.join(" ")}` : directive;
    })
    .join("; ");
}

/** `'nonce-…'` for a document rendered now; 128 bits, base64. */
export function nonceSource(nonce: string): string {
  return `'nonce-${nonce}'`;
}

/**
 * `'sha256-…'` for every inline `<script>` in a prebuilt document (the SPA shell), which cannot carry
 * a per-request nonce. Scripts with a `src` are covered by `'self'`.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const [, attributes, body] = match;
    if (/\bsrc\s*=/i.test(attributes ?? "")) continue;
    hashes.push(
      `'sha256-${createHash("sha256")
        .update(body ?? "")
        .digest("base64")}'`,
    );
  }
  return hashes;
}

/**
 * Gives every request a nonce (`c.var.cspNonce`, handed to React Router through `cspNonceContext`)
 * and sets `Content-Security-Policy` on HTML responses that don't set their own. Register it right
 * before the React Router catch-all: responses from earlier middleware (static files, the SPA shell)
 * set the header themselves where it applies.
 */
export function cspMiddleware(policy: ContentSecurityPolicy): MiddlewareHandler {
  const withNonce = !policy["script-src"]?.includes("'unsafe-inline'");
  return async (c, next) => {
    const nonce = randomBytes(16).toString("base64");
    c.set("cspNonce", nonce);
    await next();
    if (!c.res.headers.get("content-type")?.startsWith("text/html")) return;
    if (c.res.headers.has("content-security-policy")) return;
    c.header("Content-Security-Policy", serializePolicy(policy, withNonce ? [nonceSource(nonce)] : []));
  };
}
