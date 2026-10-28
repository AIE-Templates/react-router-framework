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
  delete window.desktop;
  vi.restoreAllMocks();
  for (const name of Object.keys(document.documentElement.dataset)) delete document.documentElement.dataset[name];
});

describe("root loader", () => {
  it("reports no nonce without a Content-Security-Policy", () => {
    expect(loader(loaderArgs(createTestContext()))).toEqual({ nonce: undefined });
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
  it("keeps inline safety and bootstrap handoff available when root data is missing", async () => {
    const release = vi.fn<() => void>();
    window.desktop = {
      platform: "darwin",
      version: "1",
      bootstrap: {
        protocolVersion: 1,
        shell: { kind: "desktop", platform: "darwin", osVersion: "26" },
        mode: "system-decorated",
      },
      subscribeWindowState: () => release,
      updateOverlayAppearance: async () => ({ status: "unsupported", reason: "system-decorated" }),
      setPref: async () => ({ status: "applied" }),
      removePref: async () => ({ status: "applied" }),
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const Stub = createRoutesStub([
      {
        id: "root",
        path: "/",
        Component: () => (
          <Layout>
            <main>Root error fallback</main>
          </Layout>
        ),
      },
    ]);
    const { unmount } = render(<Stub />);
    await waitFor(() => expect(document.documentElement.dataset.shell).toBe("desktop"));
    expect(document.documentElement.dataset.titlebar).toBe("native");
    expect(document.querySelector("#window-chrome-safety")?.textContent).toContain("env(titlebar-area-height,0px)");
    expect(document.querySelector(".root-frame > .root-chrome-fallback [data-window-drag]")).not.toBeNull();
    expect(document.querySelector(".root-content main")).toHaveTextContent("Root error fallback");
    unmount();
    expect(release).toHaveBeenCalledOnce();
  });

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
