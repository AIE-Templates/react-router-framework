import { runInNewContext } from "node:vm";

import { visualRecordKernel, type VisualRecord } from "@repo/shared";
import { act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { createRoutesStub, RouterContextProvider } from "react-router";
import { expect, it, vi } from "vitest";

import { visualCookie } from "~/config/visual-cookie";
import { cspNonceContext } from "~/lib/csp";
import { writeVisualCookie } from "~/managers/visual/cookie";
import { useVisualState } from "~/managers/visual/hooks";

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
  const context = new RouterContextProvider();
  context.set(cspNonceContext, undefined);
  return loader({
    request: new Request(url, { headers: { Cookie: header } }),
    url,
    pattern: "/",
    params: {},
    context,
  });
}
function tree(data: ReturnType<typeof loader>) {
  return <Stub initialEntries={["/"]} hydrationData={{ loaderData: { root: data } }} />;
}
it.each(["", visualCookie.name + "=%", visualCookie.name + "=%7B%7D"])(
  "G2 renders the product default with a missing or invalid cookie %#",
  (header) => {
    const data = rootData(header);
    expect(data.managersInitialState.visual).toBeUndefined();
    const html = new DOMParser().parseFromString(renderToString(tree(data)), "text/html");
    expect(html.documentElement.dataset.colorScheme).toBe("light");
    expect(html.documentElement.dir).toBe("ltr");
    expect(html.documentElement.dataset.reducedMotion).toBeUndefined();
    expect(html.querySelector('meta[name="color-scheme"]')).toBeNull();
  },
);
it("E5 hydrates the request snapshot and preserves the newer prepaint attributes and single head script", async () => {
  const record: VisualRecord = {
    version: 1,
    stamp: { t: 1, id: "a" },
    preferences: { colorScheme: "dark", reducedMotion: "reduce" },
  };
  const data = rootData(
    "another=1; " + visualCookie.name + "=" + encodeURIComponent(visualRecordKernel.encode(record)),
  );
  const app = tree(data);
  const html = new DOMParser().parseFromString(renderToString(app), "text/html");
  expect(html.documentElement.dataset.colorScheme).toBe("dark");
  expect(html.documentElement.dataset.reducedMotion).toBe("reduce");
  expect(html.querySelector("main")?.textContent).toBe("dark");
  const original = document.documentElement.cloneNode(true);
  const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    document.replaceChild(document.importNode(html.documentElement, true), document.documentElement);
    const current = visualRecordKernel.encode({
      ...record,
      stamp: { t: 2, id: "a" },
      preferences: { direction: "rtl", colorScheme: "light" },
    });
    writeVisualCookie(window, current);
    runInNewContext(document.querySelector("[data-visual-init]")!.textContent, { window, document });
    expect(document.documentElement.dataset.colorScheme).toBe("light");
    expect(document.querySelector("main")?.textContent).toBe("dark");
    const recover = vi.fn<(error: unknown) => void>();
    await act(async () => {
      root = hydrateRoot(document, app, { onRecoverableError: recover });
    });
    expect(recover).not.toHaveBeenCalled();
    expect(document.querySelector("main")?.textContent).toBe("light");
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.head.querySelectorAll("[data-visual-init]")).toHaveLength(1);
    expect(document.head.querySelectorAll('meta[name="viewport"]')).toHaveLength(1);
    expect(document.head.querySelectorAll("#window-chrome-safety")).toHaveLength(1);
  } finally {
    await act(async () => root?.unmount());
    document.replaceChild(original, document.documentElement);
    scroll.mockRestore();
    delete window.frameworkVisualBootstrap;
    localStorage.clear();
    document.cookie = visualCookie.name + "=; Path=/; Max-Age=0";
  }
});
