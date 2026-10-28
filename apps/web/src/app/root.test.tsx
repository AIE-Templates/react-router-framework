import { render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Layout } from "./root";

afterEach(() => {
  delete window.desktop;
  vi.restoreAllMocks();
  for (const name of Object.keys(document.documentElement.dataset)) delete document.documentElement.dataset[name];
});

// React renders <html> as the document's own element, so the attributes land on documentElement.
function renderLayout(page = <main>page</main>) {
  // <html> inside the test container is invalid nesting, which React reports.
  vi.spyOn(console, "error").mockImplementation(() => {});
  // ScrollRestoration scrolls, which jsdom does not implement.
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const Stub = createRoutesStub([{ id: "root", path: "/", Component: () => <Layout>{page}</Layout> }]);
  return render(<Stub initialEntries={["/"]} />);
}

describe("Layout", () => {
  it("keeps inline safety and bootstrap handoff available without root data", async () => {
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
    const { unmount } = renderLayout(<main>Root error fallback</main>);
    await waitFor(() => expect(document.documentElement.dataset.shell).toBe("desktop"));
    expect(document.documentElement.dataset.titlebar).toBe("native");
    expect(document.querySelector("#window-chrome-safety")?.textContent).toContain("env(titlebar-area-height,0px)");
    expect(document.querySelector(".root-frame > .root-chrome-fallback [data-window-drag]")).not.toBeNull();
    expect(document.querySelector(".root-content main")).toHaveTextContent("Root error fallback");
    unmount();
    expect(release).toHaveBeenCalledOnce();
  });

  it("marks the document as web, without desktop attributes", async () => {
    renderLayout();
    const html = document.documentElement;

    await waitFor(() => expect(html.dataset.shell).toBe("web"));
    expect(html.dataset.platform).toBeUndefined();
    expect(html.dataset.titlebar).toBeUndefined();
    expect(html.dataset.fullscreen).toBeUndefined();
  });

  it("marks the document as hydrated once the client code ran", async () => {
    renderLayout();

    await waitFor(() => expect(document.documentElement.dataset.hydrated).toBe("true"));
  });
});
