import type { VisualThemeResult, WindowChromeBridge } from "@repo/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { VisualManagerContext } from "~/managers/visual/context";
import { createVisualManager } from "~/managers/visual/manager";

import { useDesktopVisualStatus } from "./desktop-visual-context";
import { DesktopVisualSync } from "./desktop-visual-sync";

vi.mock("~/providers/environment", () => ({
  useAppEnvironment: () => ({ enhancement: "available", shell: { kind: "desktop" } }),
}));
const processed: VisualThemeResult = {
  status: "processed",
  background: "applied",
  overlay: "unsupported",
  persistence: "saved",
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
    updateOverlayAppearance: async () => ({ status: "unsupported", reason: "test" }),
  };
  window.desktop = Object.assign(bridge, { syncVisualTheme });
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
    close: () => {
      view.unmount();
      disconnect();
    },
  };
}
afterEach(() => {
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
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("bridge-unavailable"));
  act(() => view.manager.actions.setColorSchemePreference("auto"));
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
