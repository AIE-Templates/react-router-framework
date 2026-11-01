// @vitest-environment jsdom
import type { DesktopRequest, Shell } from "@repo/shared";
import { render, waitFor } from "@testing-library/react";
import { createRoutesStub, RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Layout, loader } from "~/root";

import { createLoadContext } from "./app";
import { createTestContext } from "./testing";

const desktop: Shell = { kind: "desktop", platform: "darwin", osVersion: "26.1" };
const facts: DesktopRequest = {
  titlebar: "custom",
  chromeMode: "system-decorated",
  fullscreen: true,
  prefs: { theme: "dark" },
};

function loaderArgs(context: RouterContextProvider): Parameters<typeof loader>[0] {
  const url = new URL("http://localhost/");
  return { context, request: new Request(url), url, params: {}, pattern: "/" };
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

  it("reports the desktop shell and its per-request facts", () => {
    const context = createLoadContext(new Request("http://localhost/"), { shell: desktop, desktop: facts });

    expect(loader(loaderArgs(context))).toEqual({
      shell: desktop,
      desktop: facts,
      nonce: undefined,
      managersInitialState: { visual: undefined },
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
