// @vitest-environment jsdom
import { runInNewContext } from "node:vm";

import { useMantineColorScheme } from "@mantine/core";
import {
  visualRecordKernel,
  type VisualRecord,
  type DesktopBridge,
  type DesktopRequest,
  type DesktopWindowState,
  type Shell,
} from "@repo/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { createRoutesStub, RouterContextProvider, useLoaderData } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { visualCookie } from "~/config/visual-cookie";
import { writeVisualCookie } from "~/managers/visual/cookie";
import { Layout, loader } from "~/root";

import { createLoadContext } from "./app";
import { createTestContext } from "./testing";

const desktop: Shell = { kind: "desktop", platform: "darwin", osVersion: "26.1" };
const facts: DesktopRequest = {
  titlebar: "custom",
  chromeMode: "system-decorated",
  fullscreen: true,
  prefs: { theme: "light" },
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

type RootLoader = (
  args: Parameters<typeof loader>[0],
) => ReturnType<typeof loader> | Promise<ReturnType<typeof loader>>;

// React renders <html> as the document's own element, so the attributes land on documentElement.
function renderLayout(context: RouterContextProvider, load: RootLoader = loader, children: ReactNode = "page") {
  // <html> inside the test container is invalid nesting, which React reports.
  vi.spyOn(console, "error").mockImplementation(() => {});
  // ScrollRestoration scrolls, which jsdom does not implement.
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const Stub = createRoutesStub(
    [
      {
        id: "root",
        path: "/",
        loader: load,
        Component: () => <Layout>{children}</Layout>,
        HydrateFallback: () => null,
      },
    ],
    context,
  );
  render(<Stub initialEntries={["/"]} />);
  return document.documentElement;
}
function PeerPreference() {
  return <output>{useLoaderData<typeof loader>().desktop?.prefs.burst ?? "unset"}</output>;
}

function MantineScheme() {
  return <output>{useMantineColorScheme().colorScheme}</output>;
}

describe("Layout", () => {
  it("hydrates the global light scheme into a fixed dark Electron window without reverting prepaint", async () => {
    const raw = visualRecordKernel.encode({
      version: 1,
      stamp: { t: 1, id: "a" },
      preferences: { colorScheme: "light" },
    });
    const request = new Request("http://localhost/", {
      headers: { Cookie: visualCookie.name + "=" + encodeURIComponent(raw) },
    });
    const data = loader(loaderArgs(createLoadContext(request, { shell: desktop, desktop: facts }), request));
    const Stub = createRoutesStub([
      {
        id: "root",
        path: "/",
        Component: () => (
          <Layout>
            <MantineScheme />
          </Layout>
        ),
      },
    ]);
    const app = <Stub initialEntries={["/"]} hydrationData={{ loaderData: { root: data } }} />;
    const html = new DOMParser().parseFromString(renderToString(app), "text/html");
    expect(html.querySelector("output")?.textContent).toBe("light");
    expect(html.documentElement.dataset.mantineColorScheme).toBe("light");

    const original = document.documentElement;
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      document.replaceChild(document.importNode(html.documentElement, true), original);
      writeVisualCookie(window, raw);
      const mirror = { record: raw, pending: false };
      const seed = { ...mirror, fixedAppearance: "dark" as const };
      const pushVisual = vi.fn<DesktopBridge["pushVisual"]>(async () => "ok");
      const bridge = {
        platform: "darwin",
        version: "1",
        bootstrap: { protocolVersion: 1, shell: desktop, mode: "system-decorated" },
        subscribeWindowState: () => () => {},
        declareOverlayAppearance: async () => ({ status: "unsupported", reason: "system-decorated" }),
        visualSeed: seed,
        readVisual: () => mirror,
        pushVisual,
      } satisfies Omit<DesktopBridge, "setPref" | "removePref">;
      window.desktop = bridge;
      runInNewContext(document.querySelector("[data-visual-init]")!.textContent, { window, document });
      const htmlRoot = document.documentElement;
      expect(htmlRoot.dataset.colorScheme).toBe("dark");
      expect(htmlRoot.dataset.mantineColorScheme).toBe("dark");
      const writes = vi.spyOn(htmlRoot, "setAttribute");
      const recover = vi.fn<(error: unknown) => void>();
      vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      await act(async () => {
        root = hydrateRoot(document, app, { onRecoverableError: recover });
      });
      expect(recover).not.toHaveBeenCalled();
      expect(document.querySelector("output")).toHaveTextContent("dark");
      expect(
        writes.mock.calls.filter(
          ([name, value]) => (name === "data-color-scheme" || name === "data-mantine-color-scheme") && value !== "dark",
        ),
      ).toEqual([]);
      expect(window.frameworkVisualBootstrap?.record?.preferences.colorScheme).toBe("light");
      expect(pushVisual).not.toHaveBeenCalled();
    } finally {
      await act(async () => root?.unmount());
      document.replaceChild(original, document.documentElement);
      delete window.frameworkVisualBootstrap;
      localStorage.clear();
      document.cookie = visualCookie.name + "=; Path=/; Max-Age=0";
    }
  });

  it("renders native fullscreen from loader data before connecting the renderer", () => {
    const context = createLoadContext(new Request("http://localhost/"), { shell: desktop, desktop: facts });
    const data = loader(loaderArgs(context));
    const Stub = createRoutesStub([{ id: "root", path: "/", Component: () => <Layout>page</Layout> }], context);
    const html = renderToString(<Stub initialEntries={["/"]} hydrationData={{ loaderData: { root: data } }} />);
    expect(html).toContain('data-fullscreen="true"');
  });

  it("keeps host identity and clears the fullscreen seed when preload is absent", async () => {
    const html = renderLayout(createLoadContext(new Request("http://localhost/"), { shell: desktop, desktop: facts }));

    await waitFor(() => expect(html.dataset.chromeEnhancement).toBe("unavailable"));
    expect(html.dataset.shell).toBe("desktop");
    expect(html.dataset.platform).toBe("darwin");
    expect(html.dataset.titlebar).toBe("native");
    expect(html.dataset.fullscreen).toBeUndefined();
  });

  it("preserves the seed until the first native state and follows later fullscreen transitions", async () => {
    let emit!: (state: DesktopWindowState) => void;
    window.desktop = {
      platform: desktop.platform,
      version: "1",
      bootstrap: { protocolVersion: 1, shell: desktop, mode: "system-decorated" },
      subscribeWindowState(listener) {
        emit = listener;
        return () => {};
      },
      declareOverlayAppearance: async () => ({ status: "unsupported", reason: "system-decorated" }),
    };
    const html = renderLayout(createLoadContext(new Request("http://localhost/"), { shell: desktop, desktop: facts }));
    await waitFor(() => expect(html.dataset.chromeEnhancement).toBe("available"));
    expect(html.dataset.fullscreen).toBe("true");
    act(() => emit({ revision: 1, focused: true, maximized: false, fullscreen: false }));
    expect(html.dataset.fullscreen).toBe("false");
    act(() => emit({ revision: 2, focused: true, maximized: false, fullscreen: true }));
    expect(html.dataset.fullscreen).toBe("true");
  });

  it("commits peer preference batches in order without reconnecting the visual bridge", async () => {
    const subscribe = vi.fn<NonNullable<DesktopBridge["subscribePreferences"]>>(() => () => {});
    const readVisual = vi.fn<DesktopBridge["readVisual"]>(() => ({ record: null, pending: false }));
    const pushVisual = vi.fn<DesktopBridge["pushVisual"]>(async () => "ok");
    const bridge: DesktopBridge = {
      platform: "darwin",
      version: "1",
      bootstrap: { protocolVersion: 1, shell: desktop, mode: "system-decorated" },
      subscribeWindowState: () => () => {},
      declareOverlayAppearance: async () => ({ status: "unsupported", reason: "system-decorated" }),
      visualSeed: null,
      readVisual,
      pushVisual,
      setPref: async () => ({ status: "applied" }),
      removePref: async () => ({ status: "applied" }),
      subscribePreferences: subscribe,
    };
    window.desktop = bridge;
    let prefs: DesktopRequest["prefs"] = {};
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = vi.fn<RootLoader>(async (args) => {
      const context = createLoadContext(args.request, { shell: desktop, desktop: { ...facts, prefs } });
      const result = loader({ ...args, context });
      if (prefs.burst === "first") await gate;
      return result;
    });
    await act(async () => {
      renderLayout(createTestContext(), load, <PeerPreference />);
    });
    expect(screen.getByRole("status")).toHaveTextContent("unset");
    expect(readVisual).toHaveBeenCalledOnce();
    const notify = subscribe.mock.calls[0][1];
    const readCookie = vi.spyOn(document, "cookie", "get");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      prefs = { burst: "first" };
      notify();
      await act(() => vi.runOnlyPendingTimersAsync());
      expect(load).toHaveBeenCalledTimes(2);
      for (const burst of ["intermediate", "final"]) {
        prefs = { burst };
        notify();
      }
      await act(() => vi.runOnlyPendingTimersAsync());
      expect(load).toHaveBeenCalledTimes(2);
      expect(load.mock.calls[1][0].request.signal.aborted).toBe(false);
      await act(async () => release());
      expect(screen.getByRole("status")).toHaveTextContent("first");
      await act(() => vi.runOnlyPendingTimersAsync());
      expect(screen.getByRole("status")).toHaveTextContent("final");
      expect(load).toHaveBeenCalledTimes(3);
      expect(subscribe).toHaveBeenCalledOnce();
      expect(readVisual).toHaveBeenCalledOnce();
      expect(pushVisual).not.toHaveBeenCalled();
      expect(readCookie).not.toHaveBeenCalled();
    } finally {
      release();
      vi.useRealTimers();
    }
  });
});
