import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { configureUserData } from "./user-data.ts";

it.each([undefined, "", "dev", "bench", "isolated-smoke"])(
  "keeps utility cache inside selected userData: %s",
  (suffix) => {
    const original = join("apps", "Desktop");
    let current = original;
    const app = {
      getPath: () => current,
      setPath: vi.fn<(name: "userData", path: string) => void>((_name, path) => {
        current = path;
      }),
    };
    const result = configureUserData(app, suffix);
    const expected = suffix ? `${original}-${suffix}` : original;
    expect(result).toEqual({ userData: expected, compileCacheDir: join(expected, "compile-cache") });
    expect(current).toBe(expected);
    expect(app.setPath).toHaveBeenCalledTimes(suffix ? 1 : 0);
  },
);
