// @vitest-environment node
import type { LoaderFunctionArgs } from "react-router";
import { describe, expect, it } from "vitest";

import { apiContext } from "~/lib/api";

import { createTestContext } from "./testing";

// Exercise the same apiContext entry point a route loader uses against the real in-process BFF.
async function loader({ context }: Pick<LoaderFunctionArgs, "context">) {
  const response = await context.get(apiContext).api.health.$get();
  return response.json();
}

describe("loaders using apiContext", () => {
  it("call the real BFF in-process with createTestContext()", async () => {
    const result = await loader({ context: createTestContext() });

    expect(result).toEqual({ status: "ok" });
  });
});
