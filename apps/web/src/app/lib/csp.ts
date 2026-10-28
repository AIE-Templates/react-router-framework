import { createContext } from "react-router";

/**
 * The Content-Security-Policy nonce for the document being rendered, set by the host for every
 * request. `entry.server.tsx` passes it to `<ServerRouter>` and React, which put it on the inline
 * scripts they emit; the host puts the matching `'nonce-…'` in the response's `Content-Security-Policy`.
 * `undefined` where no host set one (tests, or `csp: false`).
 */
export const cspNonceContext = createContext<string | undefined>(undefined);
