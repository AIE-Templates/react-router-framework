// @vitest-environment jsdom
import { visualRecordKernel, type VisualRecord, type DesktopRequest, type Shell } from "@repo/shared";
import { render, waitFor } from "@testing-library/react";
import { createRoutesStub, RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { visualCookie } from "~/config/visual-cookie";
import { Layout, loader } from "~/root";

import { createLoadContext } from "./app";
import { createTestContext } from "./testing";

const desktop: Shell = { kind: "desktop", platform: "darwin", osVersion: "26.1" };
const facts: DesktopRequest = {
  titlebar: "custom",
  chromeMode: "system-decorated",
  fullscreen: true,
  prefs: { theme: "light" },
  visualTheme: { preference: "dark", revision: 4 },
};

function loaderArgs(
  context: RouterContextProvider,
  request = new Request("http://localhost/"),
): Parameters<typeof loader>[0] {
  const url = new URL(request.url);
  return { context, request, url, params: {}, pattern: "/" };
}

afterEach(() => {
  delete window.desktop;
  vi.restoreAllMocks();
  for (const name of Object.keys(document.documentElement.dataset)) delete document.documentElement.dataset[name];
});

describe("root loader", () => {
  it("reports the web shell, without desktop facts", () => {
    expect(loader(loaderArgs(createTestContext()))).toEqual({
      shell: { kind: "web" },
      desktop: undefined,
      nonce: undefined,
      managersInitialState: { visual: undefined },
    });
  });

  it("seeds desktop SSR appearance from the request cookie along with shell and window facts", () => {
    const visual: VisualRecord = { version: 1, stamp: { t: 1, id: "a" }, preferences: { colorScheme: "light" } };
    const request = new Request("http://localhost/", {
      headers: { Cookie: visualCookie.name + "=" + encodeURIComponent(visualRecordKernel.encode(visual)) },
    });
    const context = createLoadContext(request, { shell: desktop, desktop: facts });

    expect(loader(loaderArgs(context, request))).toEqual({
      shell: desktop,
      desktop: facts,
      nonce: undefined,
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
  it("marks the document with the desktop shell's platform and per-request facts", async () => {
    const html = renderLayout(createLoadContext(new Request("http://localhost/"), { shell: desktop, desktop: facts }));

    await waitFor(() => expect(html.dataset.shell).toBe("desktop"));
    expect(html.dataset.platform).toBe("darwin");
    expect(html.dataset.titlebar).toBe("native");
    expect(html.dataset.fullscreen).toBe("true");
  });
});
