// @vitest-environment node
import { describe, expect, it } from "vitest";

import { clientLoader } from "./features/main/not-found.route";
import routes from "./routes";

describe("missing-route hydration", () => {
  it("matches unknown SPA URLs before hydration and reports a 404 from its client loader", async () => {
    expect(routes.find((entry) => entry.path === "*")?.file).toBe("features/main/not-found.route.tsx");
    let error: unknown;
    try {
      clientLoader();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Response);
    if (!(error instanceof Response)) throw new Error("Missing route did not return an HTTP error");
    expect(error.status).toBe(404);
    expect(await error.text()).toBe("Not Found");
  });
});
