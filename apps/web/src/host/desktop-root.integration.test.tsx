// @vitest-environment jsdom
import {
  visualRecordKernel,
  type VisualRecord,
  type DesktopBridge,
  type DesktopRequest,
  type Shell,
} from "@repo/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createRoutesStub, RouterContextProvider, useLoaderData } from "react-router";
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

describe("Layout", () => {
  it("marks the document with the desktop shell's platform and per-request facts", async () => {
    const html = renderLayout(createLoadContext(new Request("http://localhost/"), { shell: desktop, desktop: facts }));

    await waitFor(() => expect(html.dataset.shell).toBe("desktop"));
    expect(html.dataset.platform).toBe("darwin");
    expect(html.dataset.titlebar).toBe("native");
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
