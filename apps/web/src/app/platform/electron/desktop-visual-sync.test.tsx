import type { VisualThemeResult, VisualThemeSnapshot, WindowChromeBridge } from "@repo/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { VisualManagerContext } from "~/managers/visual/context";
import { createVisualManager } from "~/managers/visual/manager";

import { useDesktopVisualStatus } from "./desktop-visual-context";
import { DesktopVisualSync } from "./desktop-visual-sync";

const environment = vi.hoisted(() => ({ available: true }));
vi.mock("~/managers/environment/hooks", () => ({
  useAppEnvironment: () => ({
    enhancement: environment.available ? "available" : "unavailable",
    shell: { kind: "desktop" },
  }),
}));
const processed: VisualThemeResult = {
  status: "processed",
  background: "applied",
  overlay: "unsupported",
  persistence: "saved",
  snapshot: { revision: 1, preference: "dark" },
};
function Status() {
  return <output>{JSON.stringify(useDesktopVisualStatus())}</output>;
}
function mount(syncVisualTheme: (preference: string) => Promise<VisualThemeResult>) {
  const bridge: WindowChromeBridge = {
    platform: "darwin",
    version: "1",
    bootstrap: null,
    subscribeWindowState: () => () => {},
    declareOverlayAppearance: async () => ({ status: "unsupported", reason: "test" }),
  };
  const seed = { revision: 0, preference: "light" } as const;
  let listener: ((snapshot: VisualThemeSnapshot) => void) | undefined;
  window.desktop = Object.assign(bridge, {
    syncVisualTheme,
    visualTheme: seed,
    subscribeVisualTheme: (cb: (snapshot: VisualThemeSnapshot) => void) => {
      listener = cb;
      return () => {
        listener = undefined;
      };
    },
  });
  const manager = createVisualManager({ host: window });
  const disconnect = manager.connect();
  const view = render(
    <VisualManagerContext.Provider value={manager}>
      <DesktopVisualSync>
        <Status />
      </DesktopVisualSync>
    </VisualManagerContext.Provider>,
  );
  return {
    manager,
    push: (snapshot: VisualThemeSnapshot) => listener?.(snapshot),
    refresh: () =>
      view.rerender(
        <VisualManagerContext.Provider value={manager}>
          <DesktopVisualSync>
            <Status />
          </DesktopVisualSync>
        </VisualManagerContext.Provider>,
      ),
    close: () => {
      view.unmount();
      disconnect();
    },
  };
}
afterEach(() => {
  environment.available = true;
  delete window.desktop;
  localStorage.clear();
  delete window.frameworkVisualBootstrap;
});
it("contains synchronous bridge failures and retries a repeated command", async () => {
  const sync = vi
    .fn<(preference: string) => Promise<VisualThemeResult>>()
    .mockImplementationOnce(() => {
      throw new Error("bridge lost");
    })
    .mockResolvedValue(processed);
  const view = mount(sync);
  expect(sync).not.toHaveBeenCalled();
  act(() => view.manager.actions.setColorSchemePreference("dark"));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("bridge-unavailable"));
  expect(view.manager.getSnapshot().preferences.colorScheme).toBe("light");
  expect(view.manager.getStatus().colorSchemeSaveFailed).toBe(true);
  act(() => view.manager.actions.retryColorScheme());
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent('"persistence":"saved"'));
  expect(sync).toHaveBeenCalledTimes(2);
  view.close();
});
it("does not publish a stale response after a newer preference has completed", async () => {
  let finish: ((result: VisualThemeResult) => void) | undefined;
  const sync = vi
    .fn<(preference: string) => Promise<VisualThemeResult>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(processed);
  const view = mount(sync);
  act(() => view.manager.actions.setColorSchemePreference("auto"));
  await waitFor(() => expect(sync).toHaveBeenCalledOnce());
  act(() => view.manager.actions.setColorSchemePreference("dark"));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent('"persistence":"saved"'));
  await act(async () => {
    finish?.({ status: "rejected", reason: "stale-failure" });
    await Promise.resolve();
  });
  expect(screen.getByRole("status")).not.toHaveTextContent("stale-failure");
  view.close();
});

it("stops reporting an applied result when the host enhancement becomes unavailable", async () => {
  const view = mount(async () => processed);
  act(() => view.manager.actions.setColorSchemePreference("dark"));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent('"persistence":"saved"'));
  environment.available = false;
  view.refresh();
  expect(screen.getByRole("status")).toHaveTextContent('"status":"idle"');
  view.close();
});

it("adopts fresh pushes without writing back and ignores stale snapshots", () => {
  const sync = vi.fn<() => Promise<VisualThemeResult>>(async () => processed);
  const view = mount(sync);
  act(() => {
    view.push({ revision: 3, preference: "dark" });
    view.push({ revision: 2, preference: "light" });
    view.manager.actions.setDirection("rtl");
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
  });
  expect(view.manager.getSnapshot().preferences).toMatchObject({ colorScheme: "dark", direction: "rtl" });
  expect(document.documentElement.dataset.colorScheme).toBe("dark");
  expect(sync).not.toHaveBeenCalled();
  view.close();
});

it("sends one explicit reset, keeps the committed theme on failure and retries only the theme", async () => {
  const snapshot = { revision: 2, preference: "auto" } as const;
  const sync = vi
    .fn<(preference: string) => Promise<VisualThemeResult>>()
    .mockResolvedValueOnce({ status: "rejected", reason: "persistence-failed" })
    .mockResolvedValue({ ...processed, snapshot });
  const view = mount(sync);
  act(() => {
    view.manager.actions.setDirection("rtl");
    view.manager.actions.setReducedMotionPreference("reduce");
    view.manager.actions.resetVisualPreferences();
  });
  await waitFor(() => expect(view.manager.getStatus().colorSchemeSaveFailed).toBe(true));
  expect(view.manager.getSnapshot().preferences).toEqual({
    colorScheme: "light",
    direction: "ltr",
    reducedMotion: "auto",
  });
  act(() => {
    view.manager.actions.setDirection("rtl");
    view.manager.actions.retryColorScheme();
  });
  await waitFor(() =>
    expect(view.manager.getSnapshot().preferences).toEqual({
      colorScheme: "auto",
      direction: "rtl",
      reducedMotion: "auto",
    }),
  );
  expect(sync.mock.calls).toEqual([["auto"], ["auto"]]);
  view.close();
});
