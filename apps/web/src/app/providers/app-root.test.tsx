import type { WindowChromeBridge } from "@repo/shared";
import { act, render, screen } from "@testing-library/react";
import { Activity, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BasicShell, NavigationShell } from "~/layouts/app-shell/app-shell";
import { useAppEnvironment } from "~/managers/environment/hooks";
import { ChromeAdapterProvider } from "~/platform/chrome-adapter/chrome-adapter-provider";
import { useChromeSnapshot } from "~/platform/chrome-adapter/hooks";
import { useOverlayAppearance } from "~/platform/chrome-adapter/use-overlay-appearance";

import { AppRoot } from "./app-root";

function Probe() {
  const environment = useAppEnvironment();
  return (
    <span>
      {environment.shell.kind}:{environment.chrome.enhancement}
    </span>
  );
}
function desktopBridge(platform: "win32" | "darwin" = "darwin"): WindowChromeBridge {
  return {
    platform,
    version: "1",
    bootstrap: {
      protocolVersion: 1,
      shell: { kind: "desktop", platform, osVersion: "26" },
      mode: platform === "darwin" ? "system-decorated" : "native-overlay",
    },
    subscribeWindowState: vi.fn<WindowChromeBridge["subscribeWindowState"]>(() => vi.fn<() => void>()),
    declareOverlayAppearance: vi.fn<WindowChromeBridge["declareOverlayAppearance"]>(async () => ({
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

function appearanceHost() {
  let owner: string | undefined;
  let color: string | undefined;
  const host = desktopBridge("win32");
  host.declareOverlayAppearance = async (declaration) => {
    if (declaration.appearance && owner && owner !== declaration.owner)
      return { status: "rejected", reason: "appearance-owner-conflict" };
    if (declaration.appearance) {
      owner = declaration.owner;
      color = declaration.appearance.color;
    } else if (owner === declaration.owner) {
      owner = undefined;
      color = undefined;
    }
    return { status: "applied", appearance: { color: color ?? "#ffffff" } };
  };
  window.desktop = host;
  return { owner: () => owner, color: () => color };
}
function CustomWindowLayout() {
  useOverlayAppearance({ color: "#123456" });
  return <main>Workspace</main>;
}

it("lets a custom layout request and release an overlay without a shell", () => {
  const host = appearanceHost();
  const view = render(
    <AppRoot>
      <CustomWindowLayout />
    </AppRoot>,
  );
  expect(host.color()).toBe("#123456");
  view.unmount();
  expect(host.owner()).toBeUndefined();
});

function AppearanceTree() {
  return (
    <AppRoot>
      <BasicShell overlayAppearance={{ color: "#123456" }}>Content</BasicShell>
    </AppRoot>
  );
}
function editorWithAppearance(color?: string) {
  return (
    <AppRoot>
      <BasicShell overlayAppearance={color ? { color } : undefined}>Editor</BasicShell>
    </AppRoot>
  );
}
it("replaces the current shell declaration without releasing between prop changes", () => {
  const host = desktopBridge("win32");
  window.desktop = host;
  const view = render(editorWithAppearance("#123456"));
  const declaration = vi.mocked(host.declareOverlayAppearance);
  const owner = declaration.mock.calls[0]?.[0].owner;
  declaration.mockClear();
  view.rerender(editorWithAppearance("#654321"));
  expect(declaration.mock.calls.map(([value]) => value)).toEqual([
    { owner, revision: 2, appearance: { color: "#654321" } },
  ]);
  view.rerender(editorWithAppearance());
  expect(declaration).toHaveBeenLastCalledWith({ owner, revision: 3, appearance: null });
  view.unmount();
  expect(declaration).toHaveBeenCalledTimes(2);
});

it("hands ownership from the navigation shell to an editor shell in the same window", () => {
  const host = appearanceHost();
  const view = render(
    <AppRoot>
      <NavigationShell navigation="Areas" overlayAppearance={{ color: "#123456" }}>
        Home
      </NavigationShell>
    </AppRoot>,
  );
  const original = host.owner();
  view.rerender(
    <AppRoot>
      <BasicShell overlayAppearance={{ color: "#abcdef" }}>Editor</BasicShell>
    </AppRoot>,
  );
  expect(host.owner()).toBeDefined();
  expect(host.owner()).not.toBe(original);
  expect(host.color()).toBe("#abcdef");
  view.unmount();
  expect(host.owner()).toBeUndefined();
});

it("releases owned native appearance when the entire AppRoot is replaced", () => {
  const host = appearanceHost();
  const first = render(
    <StrictMode>
      <AppearanceTree />
    </StrictMode>,
  );
  expect(host.color()).toBe("#123456");
  first.unmount();
  expect(host.owner()).toBeUndefined();
  const second = render(
    <StrictMode>
      <AppearanceTree />
    </StrictMode>,
  );
  expect(host.color()).toBe("#123456");
  second.unmount();
  expect(host.owner()).toBeUndefined();
});
it("releases and reapplies native appearance when an Activity disconnects the provider effects", () => {
  const host = appearanceHost();
  const view = render(
    <Activity mode="visible">
      <AppearanceTree />
    </Activity>,
  );
  expect(host.color()).toBe("#123456");
  view.rerender(
    <Activity mode="hidden">
      <AppearanceTree />
    </Activity>,
  );
  expect(host.owner()).toBeUndefined();
  view.rerender(
    <Activity mode="visible">
      <AppearanceTree />
    </Activity>,
  );
  expect(host.color()).toBe("#123456");
  view.unmount();
  expect(host.owner()).toBeUndefined();
});

function IndependentShell() {
  const { shell, chrome } = useChromeSnapshot();
  return (
    <BasicShell overlayAppearance={{ color: "#123456" }}>
      <output>
        {shell.kind}:{String(chrome.fullscreen)}
      </output>
    </BasicShell>
  );
}

it("supplies shell, state and shell appearance outside the application environment", () => {
  const host = appearanceHost();
  const bridge = window.desktop!;
  delete window.desktop;
  const tree = (mode: "visible" | "hidden") => (
    <StrictMode>
      <Activity mode={mode}>
        <ChromeAdapterProvider initial={{ fullscreen: true }} bridge={bridge}>
          <IndependentShell />
        </ChromeAdapterProvider>
      </Activity>
    </StrictMode>
  );
  const view = render(tree("visible"));
  expect(screen.getByText("desktop:undefined")).toBeInTheDocument();
  expect(host.color()).toBe("#123456");
  view.rerender(tree("hidden"));
  expect(host.owner()).toBeUndefined();
  view.rerender(tree("visible"));
  const state = vi.mocked(bridge.subscribeWindowState).mock.lastCall![0];
  act(() => state({ focused: true, maximized: false, fullscreen: true, revision: 1 }));
  expect(screen.getByText("desktop:true")).toBeInTheDocument();
  expect(host.color()).toBe("#123456");
  view.unmount();
  expect(host.owner()).toBeUndefined();
});
