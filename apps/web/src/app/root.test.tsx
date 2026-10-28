import { render, waitFor } from "@testing-library/react";
import { createRoutesStub, RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLoadContext } from "../host/app";
import { createTestContext } from "../host/testing";
import type { Route } from "./+types/root";
import { Layout, loader } from "./root";

function loaderArgs(context: RouterContextProvider): Route.LoaderArgs {
  const url = new URL("http://localhost/");
  return { context, request: new Request(url), url, params: {}, pattern: "/" };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("root loader", () => {
  it("reports no nonce without a Content-Security-Policy", () => {
    expect(loader(loaderArgs(createTestContext()))).toEqual({ nonce: undefined });
  });
});

describe("Layout", () => {
  it("keeps the nonce the root loader delivered on the scripts", async () => {
    // <html> inside the test container is invalid nesting, which React reports.
    vi.spyOn(console, "error").mockImplementation(() => {});
    // ScrollRestoration scrolls, which jsdom does not implement.
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const context = createLoadContext(new Request("http://localhost/"), { cspNonce: "abc123" });
    const Stub = createRoutesStub(
      [{ id: "root", path: "/", loader, Component: () => <Layout>page</Layout>, HydrateFallback: () => null }],
      context,
    );
    render(<Stub initialEntries={["/"]} />);

    await waitFor(() => expect(document.querySelector("script[nonce]")).not.toBeNull());
    expect(document.querySelector("script[nonce]")?.getAttribute("nonce")).toBe("abc123");
  });
});
