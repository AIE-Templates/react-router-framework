import { runInNewContext } from "node:vm";

import { visualRecordKernel, type VisualRecord } from "@repo/shared";
import { act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { createRoutesStub, RouterContextProvider } from "react-router";
import { expect, it, vi } from "vitest";

import { visualCookie } from "~/config/visual-cookie";
import { visualBootstrapConfig } from "~/managers/visual/bootstrap";
import { readVisualCookie, writeVisualCookie } from "~/managers/visual/cookie";
import { useVisualState } from "~/managers/visual/hooks";
import { createVisualManager } from "~/managers/visual/manager";

import { Layout, loader } from "./root";

// A product with a concrete default must render it even before any script can run.
vi.mock(import("@repo/shared"), async (original) => {
  const shared = await original();
  const defaults = { ...shared.VISUAL_DEFAULTS, colorScheme: "light" as const };
  return { ...shared, VISUAL_DEFAULTS: defaults, visualRecordKernel: shared.createVisualRecordKernel(defaults) };
});

function Page() {
  return <main>{visualRecordKernel.effective(useVisualState()).colorScheme}</main>;
}
function DocumentRoute() {
  return (
    <Layout>
      <Page />
    </Layout>
  );
}
const Stub = createRoutesStub([{ id: "root", path: "/", Component: DocumentRoute }]);

function rootData(header = "") {
  const url = new URL("https://example.test/");
  return loader({
    request: new Request(url, { headers: { Cookie: header } }),
    url,
    pattern: "/",
    params: {},
    context: new RouterContextProvider(),
  });
}
function tree(data: ReturnType<typeof loader>) {
  return <Stub initialEntries={["/"]} hydrationData={{ loaderData: { root: data } }} />;
}
async function withDocument(
  app: ReturnType<typeof tree>,
  check: (prepaint: () => void, hydrate: () => Promise<void>) => Promise<void>,
) {
  const html = new DOMParser().parseFromString(renderToString(app), "text/html");
  const original = document.documentElement.cloneNode(true);
  const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    document.replaceChild(document.importNode(html.documentElement, true), document.documentElement);
    await check(
      () => runInNewContext(document.head.querySelector("[data-visual-init]")!.textContent, { window, document }),
      async () => {
        const recover = vi.fn<(error: unknown) => void>();
        await act(async () => {
          root = hydrateRoot(document, app, { onRecoverableError: recover });
        });
        expect(recover).not.toHaveBeenCalled();
        expect(document.documentElement.dataset.hydrated).toBe("true");
      },
    );
  } finally {
    await act(async () => root?.unmount());
    document.replaceChild(original, document.documentElement);
    scroll.mockRestore();
    delete window.frameworkVisualBootstrap;
    localStorage.clear();
    document.cookie = visualCookie.name + "=; Path=/; Max-Age=0";
  }
}

const auto = { version: 1, stamp: { t: 1, id: "a" }, preferences: { colorScheme: "auto" } } as const;
it.each([
  ["missing", null],
  ["explicit auto", auto],
  ["malformed encoding", "%"],
  ["missing envelope", {}],
  ["wrong version", { ...auto, version: 2 }],
  ["invalid stamp", { ...auto, stamp: { t: -1, id: "a" } }],
  ["unknown field", { ...auto, preferences: { direction: "rtl", extra: 1 } }],
  ["invalid field", { ...auto, preferences: { direction: "rtl", colorScheme: "blue" } }],
] as const)("renders, prepaints and hydrates a %s request cookie with a concrete default", async (_, value) => {
  if (value === "%") document.cookie = visualCookie.name + "=%; Path=/";
  else if (value !== null) writeVisualCookie(window, JSON.stringify(value));
  const data = rootData(document.cookie);
  const isAuto = value === auto;
  expect(data.managersInitialState.visual).toEqual(isAuto ? auto : undefined);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-color-scheme: dark)",
    addEventListener() {},
    removeEventListener() {},
  }));
  try {
    await withDocument(tree(data), async (prepaint, hydrate) => {
      const html = document.documentElement;
      expect(html.dataset.colorScheme).toBe(isAuto ? undefined : "light");
      expect(html.dir).toBe("ltr");
      expect(html.dataset.reducedMotion).toBeUndefined();
      expect(document.querySelector('meta[name="color-scheme"]')).toBeNull();
      expect(document.querySelector("main")?.textContent).toBe(isAuto ? "auto" : "light");
      prepaint();
      expect(html.dataset.colorScheme).toBe(isAuto ? "dark" : "light");
      expect(window.frameworkVisualBootstrap?.record).toEqual(isAuto ? auto : undefined);
      await hydrate();
      expect(html.dataset.colorScheme).toBe(isAuto ? "dark" : "light");
      expect(document.querySelector("main")?.textContent).toBe(isAuto ? "auto" : "light");
      expect(localStorage.getItem(visualBootstrapConfig.storageKey)).toBe(
        isAuto ? visualRecordKernel.encode(auto) : null,
      );
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each(["E4 stale cookie", "E5 request in flight"])(
  "%s hydrates the request snapshot and uses the current document cookie at first paint and connection",
  async (scenario) => {
    const record: VisualRecord = {
      version: 1,
      stamp: { t: 1, id: "a" },
      preferences: { colorScheme: "dark", reducedMotion: "reduce" },
    };
    const old = visualRecordKernel.encode(record);
    writeVisualCookie(window, old);
    // Capture the E5 request before the peer commits. E4's request starts after its cookie is overwritten.
    const inFlight = scenario === "E5 request in flight" ? rootData(document.cookie) : undefined;
    const peer = createVisualManager({ host: window });
    peer.actions.setDirection("rtl");
    peer.actions.setColorSchemePreference("light");
    const current = localStorage.getItem(visualBootstrapConfig.storageKey)!;
    expect(readVisualCookie(document.cookie, visualCookie.name)).toBe(current);
    if (!inFlight) writeVisualCookie(window, old);
    const data = inFlight ?? rootData(document.cookie);
    await withDocument(tree(data), async (prepaint, hydrate) => {
      const html = document.documentElement;
      expect(html.dataset.colorScheme).toBe("dark");
      expect(html.dataset.reducedMotion).toBe("reduce");
      expect(document.querySelector("main")?.textContent).toBe("dark");
      const scheme = inFlight ? "light" : "dark";
      const winner = inFlight ? current : old;
      prepaint();
      expect(html.dataset.colorScheme).toBe(scheme);
      expect(document.querySelector("main")?.textContent).toBe("dark");
      expect(readVisualCookie(document.cookie, visualCookie.name)).toBe(winner);
      await hydrate();
      expect(document.querySelector("main")?.textContent).toBe(scheme);
      expect(html.dir).toBe(inFlight ? "rtl" : "ltr");
      expect(html.dataset.colorScheme).toBe(scheme);
      expect(readVisualCookie(document.cookie, visualCookie.name)).toBe(winner);
      expect(localStorage.getItem(visualBootstrapConfig.storageKey)).toBe(winner);
      expect(document.head.querySelectorAll("[data-visual-init]")).toHaveLength(1);
      expect(document.head.querySelectorAll('meta[name="viewport"]')).toHaveLength(1);
      expect(document.head.querySelectorAll("#window-chrome-safety")).toHaveLength(1);
    });
  },
);
