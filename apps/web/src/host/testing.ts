import type { RouterContextProvider } from "react-router";

import { createLoadContext } from "./app";

/**
 * The same React Router context src/host/app.ts gives loaders and actions, for tests: `apiContext`
 * calls the real API in-process on behalf of `request`. Pass it to a loader directly or to
 * `createRoutesStub(routes, context)`.
 */
export function createTestContext(request = new Request("http://localhost/")): RouterContextProvider {
  return createLoadContext(request);
}
