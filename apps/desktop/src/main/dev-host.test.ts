import { afterEach, describe, expect, it, vi } from "vitest";

import { DEV_ENV } from "~/debug-env.names.ts";

const address = "http://127.0.0.1:5174";

/** The dev build's module, evaluated the way that build does: with the address compiled in. */
async function devHost(serverUrl: string | undefined) {
  vi.resetModules();
  vi.stubGlobal("DESKTOP_DEV_SERVER_URL", serverUrl);
  return (await import("./dev-host.ts")).developmentHost;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the dev build's host", () => {
  it("carries the development server address the build compiled in", async () => {
    expect(await devHost("http://127.0.0.1:5199")).toMatchObject({ serverUrl: "http://127.0.0.1:5199" });
    await expect(devHost(undefined)).rejects.toThrow("The dev build has no development server address");
  });

  it.each([
    ["dev", "dev"],
    ["review-1", "review-1"],
    ["", undefined],
    [undefined, undefined],
  ])("reads its user data suffix %j from the environment as %j", async (value, expected) => {
    vi.stubEnv(DEV_ENV.userDataSuffix, value);
    expect((await devHost(address))?.userDataSuffix).toBe(expected);
  });

  it("is the only build with one: the empty implementation reads nothing", async () => {
    vi.stubEnv(DEV_ENV.userDataSuffix, "dev");
    const { developmentHost } = await import("./dev-host.empty.ts");
    expect(developmentHost).toBeUndefined();
  });
});
