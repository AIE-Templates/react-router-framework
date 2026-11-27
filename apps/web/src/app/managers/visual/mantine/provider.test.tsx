import { Rating, useComputedColorScheme, useDirection, useMantineColorScheme } from "@mantine/core";
import { VISUAL_DEFAULTS, visualRecordKernel } from "@repo/shared";
import { act, render, screen } from "@testing-library/react";
import { Activity, useEffect, useLayoutEffect, type PropsWithChildren } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

import { STORAGE_KEYS } from "~/config/storage";
import { visualCookie } from "~/config/visual-cookie";
import { visualBootstrapConfig, visualCodec } from "~/managers/visual/bootstrap";
import { VisualManagerContext } from "~/managers/visual/context";
import { writeVisualCookie } from "~/managers/visual/cookie";
import { useVisualState } from "~/managers/visual/hooks";
import { createVisualManager } from "~/managers/visual/manager";
import { readVisualRequestSeed } from "~/managers/visual/request-seed";

import { VisualMantineProvider } from "./provider";

afterEach(() => {
  localStorage.clear();
  document.cookie = visualCookie.name + "=; Path=/; Max-Age=0";
  delete window.frameworkVisualBootstrap;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const hydrationTree = (manager: ReturnType<typeof createVisualManager>) => (
  <ConnectedVisualTree manager={manager}>
    <VisualProbe />
    <Rating value={2.5} fractions={2} readOnly />
  </ConnectedVisualTree>
);

it.each([
  { scenario: "E5: request in flight", requestScheme: "light", localScheme: "dark", fixed: undefined },
  { scenario: "B2: only local storage", requestScheme: undefined, localScheme: "dark", fixed: undefined },
  { scenario: "fixed window", requestScheme: "light", localScheme: "light", fixed: "dark" },
] as const)(
  "hydrates Mantine markup from the request before adopting the client appearance ($scenario)",
  async ({ requestScheme, localScheme, fixed }) => {
    if (requestScheme) {
      writeVisualCookie(
        window,
        visualRecordKernel.encode({
          version: 1,
          stamp: { t: 1, id: "a" },
          preferences: { colorScheme: requestScheme },
        }),
      );
    }
    const initialRecord = readVisualRequestSeed(
      new Request(window.location.href, { headers: { Cookie: document.cookie } }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    container.innerHTML = renderToString(hydrationTree(createVisualManager({ initialRecord })));
    expect(container.querySelector("output")?.dataset.scheme).toBe(requestScheme ?? VISUAL_DEFAULTS.colorScheme);
    const current = visualRecordKernel.encode({
      version: 1,
      stamp: { t: 2, id: "a" },
      preferences: { direction: "rtl", colorScheme: localScheme },
    });
    localStorage.setItem(STORAGE_KEYS.visualPreferences, current);
    if (requestScheme) writeVisualCookie(window, current);
    window.frameworkVisualBootstrap = visualCodec.read(visualBootstrapConfig, window, () => ({
      record: null,
      fixedAppearance: fixed,
    }));
    visualCodec.apply(visualBootstrapConfig, window.frameworkVisualBootstrap.state, document.documentElement);
    expect(document.documentElement.dataset.mantineColorScheme).toBe(fixed ?? localScheme);
    const attributes = vi.spyOn(document.documentElement, "setAttribute");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const recoverable = vi.fn<(error: unknown) => void>();
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(container, hydrationTree(createVisualManager({ host: window, initialRecord })), {
          onRecoverableError: recoverable,
        });
      });
      expect(recoverable).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
      const staleSchemeWrites = attributes.mock.calls.filter(
        ([name, value]) => name === "data-mantine-color-scheme" && value !== (fixed ?? localScheme),
      );
      expect(staleSchemeWrites).toEqual([]);
      expect(container.querySelector("output")?.dataset.scheme).toBe(fixed ?? localScheme);
      expect(document.documentElement.dataset.mantineColorScheme).toBe(fixed ?? localScheme);
      expect(localStorage.getItem(STORAGE_KEYS.visualPreferences)).toBe(current);
      expect(document.documentElement.dir).toBe("rtl");
      expect(container.querySelector('[style*="--rating-symbol-clip-path"]')?.getAttribute("style")).toContain(
        "inset(0 0 0",
      );
    } finally {
      await act(async () => root?.unmount());
      container.remove();
    }
  },
);
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
    <ConnectedVisualTree manager={manager}>
      <Child />
    </ConnectedVisualTree>,
  );
  expect(screen.getByRole("status")).toHaveTextContent("dark");
  expect(document.documentElement.dataset.mantineColorScheme).toBe("dark");
});

function VisualProbe() {
  const { resolved } = useVisualState();
  const { colorScheme } = useMantineColorScheme();
  const computedScheme = useComputedColorScheme();
  const { dir } = useDirection();
  return (
    <output
      data-scheme={colorScheme}
      data-computed-scheme={computedScheme}
      dir={dir}
      data-reduced-motion={resolved.reducedMotion}
    />
  );
}
function ConnectedVisualTree({
  manager,
  children,
}: PropsWithChildren<{ manager: ReturnType<typeof createVisualManager> }>) {
  useEffect(() => manager.connect(), [manager]);
  return (
    <VisualManagerContext.Provider value={manager}>
      <VisualMantineProvider>{children ?? <VisualProbe />}</VisualMantineProvider>
    </VisualManagerContext.Provider>
  );
}
it("updates the Mantine preference when another window changes the stored scheme", () => {
  const manager = createVisualManager({ host: window });
  render(<ConnectedVisualTree manager={manager} />);
  const probe = screen.getByRole("status");
  expect(probe).toHaveAttribute("data-scheme", "auto");

  const peer = createVisualManager({ host: window });
  act(() => {
    peer.actions.setColorSchemePreference("dark");
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEYS.visualPreferences }));
  });
  expect(probe).toHaveAttribute("data-scheme", "dark");
  expect(document.documentElement.dataset.mantineColorScheme).toBe("dark");
});

it("follows a fixed window appearance first reported by a live retry", () => {
  let fixedAppearance: "dark" | undefined;
  const manager = createVisualManager({
    host: window,
    nativeSource: {
      prepaint: () => undefined,
      connect: () => ({
        read: () => ({ record: null, pending: false, fixedAppearance }),
        push: async () => "ok",
      }),
    },
  });
  const subscribeStatus = vi.spyOn(manager, "subscribeStatus");
  render(<ConnectedVisualTree manager={manager} />);
  const probe = screen.getByRole("status");
  const status = manager.getStatus();
  expect(probe).toHaveAttribute("data-scheme", "auto");

  fixedAppearance = "dark";
  act(() => manager.actions.retry());
  expect(manager.getStatus()).toBe(status);
  expect(probe).toHaveAttribute("data-scheme", "dark");

  fixedAppearance = undefined;
  act(() => manager.actions.retry());
  expect(probe).toHaveAttribute("data-scheme", "auto");
  // A render from useVisualState can otherwise mask a subscription to the wrong store.
  expect(subscribeStatus).not.toHaveBeenCalled();
});

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
  const probe = screen.getByRole("status");
  expect(probe).toHaveAttribute("data-computed-scheme", "light");
  const quota = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  try {
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
    expect(probe).toHaveAttribute("data-scheme", "auto");
    expect(probe).toHaveAttribute("data-computed-scheme", "dark");
    expect(probe).toHaveAttribute("data-reduced-motion", "true");
    expect(probe).toHaveAttribute("dir", "rtl");
    expect(manager.getStatus().storage.local).toBe("failed");
    expect(document.documentElement.dataset.colorScheme).toBe("dark");
    expect(document.documentElement.dataset.mantineColorScheme).toBe("dark");
  } finally {
    quota.mockRestore();
  }
  act(() => manager.actions.retry());
  expect(manager.getStatus().storage.local).toBe("ok");
  view.unmount();
});
