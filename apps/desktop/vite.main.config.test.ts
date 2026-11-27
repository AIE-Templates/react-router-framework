import { expect, it, vi } from "vitest";

import { BUILD_PROFILE_ENV } from "./scripts/build-profile.ts";

it.each([
  { router: {}, expected: "true" },
  { router: { ssr: false }, expected: "false" },
])("defines DESKTOP_SSR as $expected for dev Router config $router", async ({ router, expected }) => {
  vi.stubEnv(BUILD_PROFILE_ENV, "dev");
  vi.stubEnv("DESKTOP_DEV_SERVER_URL", "http://localhost:5174");
  vi.doMock("../web/react-router.config.ts", () => ({ default: router }));
  try {
    const { default: configure } = await import("./vite.main.config.ts");
    const config = await configure({ command: "build", mode: "development" });
    expect(config.define?.DESKTOP_SSR).toBe(expected);
  } finally {
    vi.doUnmock("../web/react-router.config.ts");
    vi.unstubAllEnvs();
  }
});
