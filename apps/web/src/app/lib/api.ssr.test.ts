// @vitest-environment node
import { describe, expect, it } from "vitest";

import { api } from "./api";

describe("api on the server", () => {
  it("points loaders and actions to apiContext", async () => {
    await expect(api.api.health.$get()).rejects.toThrow("context.get(apiContext)");
  });
});
