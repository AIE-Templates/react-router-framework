import { Rating, useDirection, useMantineColorScheme } from "@mantine/core";
import { act, render, screen } from "@testing-library/react";
import { Activity, useEffect, useLayoutEffect } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

import { STORAGE_KEYS } from "../../../config/storage";
import { VisualManagerContext } from "../context";
import { useVisualState } from "../hooks";
import { createVisualManager } from "../manager";
import { VisualMantineProvider } from "./provider";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const tree = (manager: ReturnType<typeof createVisualManager>) => (
  <VisualManagerContext.Provider value={manager}>
    <VisualMantineProvider>
      <Rating value={2.5} fractions={2} readOnly />
    </VisualMantineProvider>
  </VisualManagerContext.Provider>
);
it("hydrates direction-dependent component markup before adopting the client direction", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  container.innerHTML = renderToString(tree(createVisualManager()));
  localStorage.setItem(
    STORAGE_KEYS.visualPreferences,
    JSON.stringify({ version: 1, preferences: { direction: "rtl" } }),
  );
  document.documentElement.dir = "rtl";
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const recoverable = vi.fn<(error: unknown) => void>();
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    await act(async () => {
      root = hydrateRoot(container, tree(createVisualManager({ host: window })), { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(document.documentElement.dir).toBe("rtl");
    expect(container.querySelector('[style*="--rating-symbol-clip-path"]')?.getAttribute("style")).toContain(
      "inset(0 0 0",
    );
  } finally {
    await act(async () => root?.unmount());
    container.remove();
  }
});
it("reconciles a preference changed by a child layout effect before Mantine subscribes", () => {
  const manager = createVisualManager({ host: window });
  function Child() {
    const { colorScheme } = useMantineColorScheme();
    useLayoutEffect(() => {
      manager.actions.setColorSchemePreference("dark");
    }, []);
    return <output>{colorScheme}</output>;
  }
  render(
    <VisualManagerContext.Provider value={manager}>
      <VisualMantineProvider>
        <Child />
      </VisualMantineProvider>
    </VisualManagerContext.Provider>,
  );
  expect(screen.getByRole("status")).toHaveTextContent("dark");
  expect(document.documentElement.dataset.mantineColorScheme).toBe("dark");
});

function VisualProbe() {
  const { resolved } = useVisualState();
  const { colorScheme } = useMantineColorScheme();
  const { dir } = useDirection();
  return <output>{JSON.stringify({ resolved, colorScheme, dir })}</output>;
}
function ConnectedVisualTree({ manager }: { manager: ReturnType<typeof createVisualManager> }) {
  useEffect(() => manager.connect(), [manager]);
  return (
    <VisualManagerContext.Provider value={manager}>
      <VisualMantineProvider>
        <VisualProbe />
      </VisualMantineProvider>
    </VisualManagerContext.Provider>
  );
}
it("restores current system preferences in Mantine after suspended effects and a failed save", () => {
  let matches = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    get matches() {
      return matches;
    },
    addEventListener() {},
    removeEventListener() {},
  }));
  const manager = createVisualManager({ host: window });
  const view = render(
    <Activity mode="visible">
      <ConnectedVisualTree manager={manager} />
    </Activity>,
  );
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  act(() => manager.actions.setDirection("rtl"));
  view.rerender(
    <Activity mode="hidden">
      <ConnectedVisualTree manager={manager} />
    </Activity>,
  );
  matches = true;
  view.rerender(
    <Activity mode="visible">
      <ConnectedVisualTree manager={manager} />
    </Activity>,
  );
  expect(screen.getByRole("status")).toHaveTextContent('"colorScheme":"dark"');
  expect(screen.getByRole("status")).toHaveTextContent('"reducedMotion":true');
  expect(screen.getByRole("status")).toHaveTextContent('"dir":"rtl"');
  expect(manager.getStatus().persistence).toBe("failed");
  expect(document.documentElement.dataset.colorScheme).toBe("dark");
  expect(document.documentElement.dataset.mantineColorScheme).toBe("dark");
  view.unmount();
});
