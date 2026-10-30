import type { WindowChromeBridge } from "@repo/shared";
import { act, render, screen } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppRoot } from "./app-root";
import { useAppEnvironment } from "./environment";

function Probe() {
  const environment = useAppEnvironment();
  return (
    <span>
      {environment.shell.kind}:{environment.enhancement}
    </span>
  );
}
function desktopBridge(): WindowChromeBridge {
  return {
    platform: "darwin",
    version: "1",
    bootstrap: {
      protocolVersion: 1,
      shell: { kind: "desktop", platform: "darwin", osVersion: "26" },
      mode: "system-decorated",
    },
    subscribeWindowState: vi.fn<WindowChromeBridge["subscribeWindowState"]>(() => vi.fn<() => void>()),
    updateOverlayAppearance: vi.fn<WindowChromeBridge["updateOverlayAppearance"]>(async () => ({
      status: "unsupported",
      reason: "system-decorated",
    })),
  };
}
afterEach(() => {
  delete window.desktop;
});

describe("AppRoot", () => {
  it("renders the SSR environment without touching the preload bridge", () => {
    const host = desktopBridge();
    window.desktop = host;
    const html = renderToString(
      <AppRoot shell={{ kind: "web" }}>
        <Probe />
      </AppRoot>,
    );
    expect(html).toContain("web");
    expect(host.subscribeWindowState).not.toHaveBeenCalled();
  });

  it("hydrates web SPA markup first, confirms desktop after mount, and cleans up", async () => {
    const host = desktopBridge();
    const release = vi.fn<() => void>();
    host.subscribeWindowState = vi.fn<WindowChromeBridge["subscribeWindowState"]>(() => release);
    const element = (
      <AppRoot shell={{ kind: "web" }}>
        <Probe />
      </AppRoot>
    );
    const container = document.createElement("div");
    container.innerHTML = renderToString(element);
    document.body.append(container);
    window.desktop = host;
    const recover = vi.fn<() => void>();
    let root!: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, element, { onRecoverableError: recover });
    });
    expect(container.textContent).toBe("desktop:available");
    expect(recover).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    expect(release).toHaveBeenCalledOnce();
    container.remove();
  });

  it("works with missing root data and ignores later stale build-time shell data", () => {
    window.desktop = desktopBridge();
    const { rerender } = render(
      <AppRoot>
        <Probe />
      </AppRoot>,
    );
    expect(screen.getByText("desktop:available")).toBeInTheDocument();
    rerender(
      <AppRoot shell={{ kind: "web" }}>
        <Probe />
      </AppRoot>,
    );
    expect(screen.getByText("desktop:available")).toBeInTheDocument();
  });

  it("keeps ordinary web use free of desktop subscription and commands", () => {
    render(
      <AppRoot>
        <Probe />
      </AppRoot>,
    );
    expect(screen.getByText("web:unavailable")).toBeInTheDocument();
  });
});
