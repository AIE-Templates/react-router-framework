import { render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Layout } from "./root";

afterEach(() => {
  delete window.desktop;
  vi.restoreAllMocks();
  for (const name of Object.keys(document.documentElement.dataset)) delete document.documentElement.dataset[name];
});

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
});
