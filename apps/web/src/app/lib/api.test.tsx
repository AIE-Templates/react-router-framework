import type { ApiType } from "@repo/server/types";
import { render, screen } from "@testing-library/react";
import { hc } from "hono/client";
import { createRoutesStub, RouterContextProvider, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { createTestContext } from "../../host/testing";
import { apiContext } from "./api";

// A loader written the way route modules call the BFF.
async function loader({ context }: Pick<LoaderFunctionArgs, "context">) {
  const response = await context.get(apiContext).api.health.$get();
  return response.json();
}

function HealthStatus() {
  const { status } = useLoaderData<typeof loader>();
  return <p>Health: {status}</p>;
}

describe("loaders using apiContext", () => {
  it("call the real BFF in-process with createTestContext()", async () => {
    const result = await loader({ context: createTestContext() });

    expect(result).toEqual({ status: "ok" });
  });

  it("can use a fake BFF client instead", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ status: "degraded" }));
    const context = new RouterContextProvider();
    context.set(apiContext, hc<ApiType>("http://localhost", { fetch }));

    const Stub = createRoutesStub([{ path: "/", Component: HealthStatus, loader }], context);
    render(<Stub initialEntries={["/"]} />);

    expect(await screen.findByText("Health: degraded")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("http://localhost/api/health", expect.anything());
  });
});
