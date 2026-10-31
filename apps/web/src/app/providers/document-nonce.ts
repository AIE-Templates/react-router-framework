import { createContext } from "react";

/** Request-local nonce remains available even when a route loader fails. */
export const DocumentNonceContext = createContext<string | undefined>(undefined);
