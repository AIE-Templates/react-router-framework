// @vitest-environment jsdom
import { visualRecordKernel, WEB_SHELL, type VisualRecord } from "@repo/shared";
import { render, waitFor } from "@testing-library/react";
import { createRoutesStub, RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { visualCookie } from "~/config/visual-cookie";
import { Layout, loader } from "~/root";

import { createLoadContext } from "./app";
import { createTestContext } from "./testing";

function loaderArgs(
  context: RouterContextProvider,
  request = new Request("http://localhost/"),
): Parameters<typeof loader>[0] {
  return { context, request, url: new URL(request.url), params: {}, pattern: "/" };
}

afterEach(() => {
  delete window.desktop;
  vi.restoreAllMocks();
  for (const name of Object.keys(document.documentElement.dataset)) delete document.documentElement.dataset[name];
});

describe("root loader", () => {
  it("reports no nonce without a Content-Security-Policy", () => {
    expect(loader(loaderArgs(createTestContext()))).toEqual({
      shell: WEB_SHELL,
      desktop: undefined,
      nonce: undefined,
      managersInitialState: { visual: undefined },
    });
  });

  it("returns the nonce together with the request's visual record", () => {
    const visual: VisualRecord = { version: 1, stamp: { t: 1, id: "a" }, preferences: { direction: "rtl" } };
    const request = new Request("http://localhost/", {
      headers: { Cookie: visualCookie.name + "=" + encodeURIComponent(visualRecordKernel.encode(visual)) },
    });
    const context = createLoadContext(request, { cspNonce: "abc123" });
    expect(loader(loaderArgs(context, request))).toEqual({
      shell: WEB_SHELL,
      desktop: undefined,
      nonce: "abc123",
      managersInitialState: { visual },
    });
  });
});

// React renders <html> as the document's own element, so the attributes land on documentElement.
function renderLayout(context: RouterContextProvider) {
  // <html> inside the test container is invalid nesting, which React reports.
  vi.spyOn(console, "error").mockImplementation(() => {});
  // ScrollRestoration scrolls, which jsdom does not implement.
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const Stub = createRoutesStub(
    [{ id: "root", path: "/", loader, Component: () => <Layout>page</Layout>, HydrateFallback: () => null }],
    context,
  );
  render(<Stub initialEntries={["/"]} />);
  return document.documentElement;
}

describe("Layout", () => {
  it("marks the document as web, without desktop attributes", async () => {
    const html = renderLayout(createTestContext());

    await waitFor(() => expect(html.dataset.shell).toBe("web"));
    expect(html.dataset.platform).toBeUndefined();
    expect(html.dataset.titlebar).toBeUndefined();
    expect(html.dataset.fullscreen).toBeUndefined();
  });

  it("marks the document as hydrated once the client code ran", async () => {
    delete document.documentElement.dataset.hydrated;
    const html = renderLayout(createTestContext());

    await waitFor(() => expect(html.dataset.hydrated).toBe("true"));
  });

  it("keeps the nonce the root loader delivered on the scripts", async () => {
    const context = createLoadContext(new Request("http://localhost/"), { cspNonce: "abc123" });
    renderLayout(context);

    await waitFor(() => expect(document.querySelector("script[nonce]")).not.toBeNull());
    expect(document.querySelector("script[nonce]")?.getAttribute("nonce")).toBe("abc123");
  });
});
