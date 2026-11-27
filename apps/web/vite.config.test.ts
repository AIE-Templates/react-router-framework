// @vitest-environment node
import { expect, it, vi } from "vitest";

import config from "./vite.config";

vi.mock("./react-router.config.ts", () => ({ default: {} }));

it("defines APP_SSR as true when the Router config omits ssr", () => {
  expect(config.define?.APP_SSR).toBe("true");
});
