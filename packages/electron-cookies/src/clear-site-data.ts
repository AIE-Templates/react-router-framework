import { abandonOn, type CookieStore } from "./store.ts";

const cookieDirective = /^[ \t]*"(?:cookies|\*)"[ \t]*$/;

// URLRequestHttpJob enumerates HTTP field values to decide whether to suppress
// Set-Cookie. Commas inside quotes do not delimit values here.
function suppressesSetCookie(header: string): boolean {
  let start = 0;
  let quoted = false;
  for (let i = 0; i < header.length; i++) {
    const character = header[i];
    if (quoted && character === "\\") i++;
    else if (character === '"') quoted = !quoted;
    else if (!quoted && character === ",") {
      if (cookieDirective.test(header.slice(start, i))) return true;
      start = i + 1;
    }
  }
  return cookieDirective.test(header.slice(start));
}

export function responseCookiePolicy(header: string, secureScheme: boolean) {
  // ClearSiteDataHandler independently rejects non-ASCII fields and splits on
  // every comma. A malformed list can therefore clear old cookies and accept new ones.
  const clear =
    secureScheme && !/\P{ASCII}/u.test(header) && header.split(",").some((value) => cookieDirective.test(value));
  return { clear, suppressSetCookie: suppressesSetCookie(header) };
}

export async function clearJarCookies(
  store: CookieStore,
  storageOrigin: string,
  storageHost: string,
  deadline: AbortSignal,
) {
  // A domain query includes every path and HttpOnly cookie. It can also return parent
  // domain cookies. Expire exact identities to preserve other hosts in this session.
  const cookies = await abandonOn(store.get({ domain: storageHost }), deadline);
  deadline.throwIfAborted();
  const deletions = cookies
    .filter(({ domain }) => domain === storageHost || domain === "." + storageHost)
    .map(async ({ name, path = "/", domain }) =>
      store.set({
        // Chromium can derive paths which would be invalid as explicit Path attributes.
        url: storageOrigin + path + (path === "/" ? "" : "/"),
        path: path === "/" ? "/" : "",
        name,
        value: name ? "" : "1",
        secure: true,
        httpOnly: true,
        sameSite: "unspecified",
        expirationDate: 1,
        ...(domain === "." + storageHost && { domain: storageHost }),
      }),
    );
  const outcomes = await abandonOn(Promise.allSettled(deletions), deadline);
  deadline.throwIfAborted();
  await abandonOn(store.flushStore(), deadline);
  if (outcomes.some((result) => result.status === "rejected"))
    throw new Error("Cookie store rejected a cookie deletion");
}
