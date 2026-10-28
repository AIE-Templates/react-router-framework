// @vitest-environment node
import { testClient } from "hono/testing";
import { describe, expect, it } from "vitest";

import { api } from "./api.ts";

describe("BFF API", () => {
  it("reports health", async () => {
    const response = await testClient(api).api.health.$get();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
