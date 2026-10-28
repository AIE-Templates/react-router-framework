import { Hono } from "hono";

/** Where the end-to-end tests' own endpoints live; nothing in the web app uses this prefix. */
export const E2E_PREFIX = "/__e2e";

/** Cookie names the endpoints set and report; anything else in the `Cookie` header is ignored. */
const COOKIE_NAME = /^e2e-[\w-]{1,48}$/;
const COOKIE_VALUE = /^[\w-]{1,64}$/;
/** Upper bound on a persistent cookie's lifetime, so a stray request cannot plant a long-lived one. */
export const MAX_E2E_COOKIE_AGE_S = 24 * 60 * 60;
/** Paths a cookie may be scoped to: the root, or somewhere under the endpoints. */
const COOKIE_PATH = /^\/(?:__e2e\/[\w/-]{0,64})?$/;

/**
 * The end-to-end tests' endpoints (`DESKTOP_E2E=1` only; the utility entry mounts them only then),
 * mounted at `E2E_PREFIX` inside the web app's chain, so they get request IDs, logging and error handling
 * like any route (not the CSRF check, which covers `/api/*` only).
 *
 * - `POST /__e2e/cookies` with JSON `{ name, value, maxAge?, path?, delete?, httpOnly? }`: answers with
 *   a `Set-Cookie` for `name=value` (`HttpOnly; SameSite=Lax`, without `HttpOnly` when `httpOnly` is
 *   false; `Path=/` unless `path` names `/` or a
 *   path under `/__e2e/`), persistent with `Max-Age` when `maxAge` is given, a session cookie
 *   otherwise; `delete: true` sends `Max-Age=0` instead, which deletes the cookie with that name and
 *   path. HttpOnly, so the tests can tell header cookies from script cookies.
 * - `GET /__e2e/cookies` and `GET /__e2e/cookies/<anything>`: the `e2e-*` cookies the request
 *   carried, as the server received them (the second for path-scoped cookies).
 */
export function e2eRoutes() {
  return new Hono()
    .get("/cookies", (c) => c.json({ cookies: parseCookies(c.req.header("cookie")) }))
    .get("/cookies/*", (c) => c.json({ cookies: parseCookies(c.req.header("cookie")) }))
    .post("/cookies", async (c) => {
      const body: unknown = await c.req.json().catch(() => null);
      if (!isCookieRequest(body)) return c.json({ error: "bad name, value or maxAge" }, 400);
      const attributes = [`Path=${body.path ?? "/"}`, ...(body.httpOnly === false ? [] : ["HttpOnly"]), "SameSite=Lax"];
      if (body.delete === true) attributes.push("Max-Age=0");
      else if (body.maxAge !== undefined) attributes.push(`Max-Age=${body.maxAge}`);
      c.header("Set-Cookie", [`${body.name}=${body.value}`, ...attributes].join("; "), { append: true });
      return c.json({ set: body.name });
    });
}

/** The `e2e-*` cookies of a `Cookie` header, by name. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of (header ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at < 0) continue;
    const name = pair.slice(0, at).trim();
    if (COOKIE_NAME.test(name)) cookies[name] = pair.slice(at + 1).trim();
  }
  return cookies;
}

interface CookieRequest {
  name: string;
  value: string;
  maxAge?: number;
  path?: string;
  delete?: boolean;
  httpOnly?: boolean;
}

function isCookieRequest(value: unknown): value is CookieRequest {
  if (typeof value !== "object" || value === null || !("name" in value) || !("value" in value)) return false;
  const maxAge = "maxAge" in value ? value.maxAge : undefined;
  const path = "path" in value ? value.path : undefined;
  const remove = "delete" in value ? value.delete : undefined;
  const httpOnly = "httpOnly" in value ? value.httpOnly : undefined;
  return (
    (httpOnly === undefined || typeof httpOnly === "boolean") &&
    (path === undefined || (typeof path === "string" && COOKIE_PATH.test(path))) &&
    (remove === undefined || typeof remove === "boolean") &&
    typeof value.name === "string" &&
    COOKIE_NAME.test(value.name) &&
    typeof value.value === "string" &&
    COOKIE_VALUE.test(value.value) &&
    (maxAge === undefined ||
      (typeof maxAge === "number" && Number.isSafeInteger(maxAge) && maxAge > 0 && maxAge <= MAX_E2E_COOKIE_AGE_S))
  );
}
