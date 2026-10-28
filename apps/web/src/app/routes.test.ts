// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { clientLoader } from "./routes/not-found";

const originalSsr = process.env.SSR;
afterEach(() => {
  if (originalSsr === undefined) delete process.env.SSR;
  else process.env.SSR = originalSsr;
  vi.resetModules();
});

describe("missing-route hydration", () => {
  it.each([undefined, "true", "FALSE"])("preserves native server 404 handling for SSR=%s", async (ssr) => {
    if (ssr === undefined) delete process.env.SSR;
    else process.env.SSR = ssr;
    vi.resetModules();
    const { default: routes } = await import("./routes");
    expect(routes.some((entry) => entry.path === "*")).toBe(false);
  });

  it("matches unknown SPA URLs before hydration and reports a 404 from its client loader", async () => {
    process.env.SSR = "false";
    vi.resetModules();
    const { default: routes } = await import("./routes");
    expect(routes.find((entry) => entry.path === "*")?.file).toBe("routes/not-found.tsx");
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
