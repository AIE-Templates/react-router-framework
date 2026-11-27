import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { visualRecordKernel } from "@repo/shared";
import { act, configure, getConfig, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import { STORAGE_KEYS } from "~/config/storage";
import { visualCookie } from "~/config/visual-cookie";
import { VisualManagerContext } from "~/managers/visual/context";
import { createVisualManager } from "~/managers/visual/manager";
import { AppUiProvider } from "~/providers/app-ui-provider";
import { renderWithProviders } from "~/testing/render";

import { VisualSettings } from "./appearance-settings";

// Menus, modals and tooltips open through timed transitions, which a loaded machine (such as a
// Windows VM running the whole suite) can delay past the default waits.
vi.setConfig({ testTimeout: 20_000 });
const { asyncUtilTimeout } = getConfig();
beforeAll(() => configure({ asyncUtilTimeout: 5000 }));
afterAll(() => configure({ asyncUtilTimeout }));

beforeAll(() => {
  // Mantine scrolls the active option into view when opening a Select; jsdom has no layout.
  const needsScrollStub = !("scrollIntoView" in HTMLElement.prototype);
  if (needsScrollStub) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} });
  }
  return () => {
    if (needsScrollStub) Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  };
});

afterEach(() => {
  act(() => {
    modals.closeAll();
    notifications.clean();
  });
  localStorage.clear();
  document.cookie = visualCookie.name + "=; Path=/; Max-Age=0";
});

// Focus return after the menu item unmounts depends on browser timing; jsdom cannot observe it.
it("confirms a reset from the menu and shows a notification", async () => {
  const user = userEvent.setup();
  const manager = createVisualManager({ host: window });
  act(() => manager.actions.setDirection("rtl"));
  render(
    <VisualManagerContext.Provider value={manager}>
      <AppUiProvider>
        <VisualSettings />
      </AppUiProvider>
    </VisualManagerContext.Provider>,
  );
  await user.click(screen.getByRole("button", { name: "Preview options" }));
  await user.click(await screen.findByRole("menuitem", { name: "Reset with confirmation" }));
  expect(await screen.findByRole("dialog", { name: "Reset appearance?" })).toHaveTextContent(
    "Color scheme, direction and motion return to their defaults.",
  );
  await user.click(screen.getByRole("button", { name: "Reset" }));

  expect(manager.getSnapshot().preferences).toEqual({});
  expect(await screen.findByText("Defaults restored.")).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Reset appearance?" })).not.toBeInTheDocument());
});

it("describes the direct reset as restoring defaults", async () => {
  const user = userEvent.setup();
  render(
    <VisualManagerContext.Provider value={createVisualManager({ host: window })}>
      <AppUiProvider>
        <VisualSettings />
      </AppUiProvider>
    </VisualManagerContext.Provider>,
  );
  await user.hover(screen.getByRole("button", { name: "Reset appearance" }));
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Restore defaults");
});

it.each([
  ["Color scheme", "System", "colorScheme", "auto"],
  ["Direction", "LTR", "direction", "ltr"],
  ["Motion", "System", "reducedMotion", "auto"],
])(
  "records an explicit %s choice when the displayed default is selected again",
  async (label, option, field, value) => {
    const user = userEvent.setup();
    renderWithProviders(<VisualSettings />);
    const select = screen.getByRole("combobox", { name: label });
    expect(select).toHaveValue(option);
    expect(localStorage.getItem(STORAGE_KEYS.visualPreferences)).toBeNull();

    await user.click(select);
    await user.keyboard("{Enter}");
    const { record } = visualRecordKernel.decode(localStorage.getItem(STORAGE_KEYS.visualPreferences));
    expect(record?.preferences).toEqual({ [field]: value });
  },
);

it("keeps effective defaults selected and reports only a failed store or complete loss of persistence", async () => {
  const user = userEvent.setup();
  const view = renderWithProviders(<VisualSettings />);
  const direction = screen.getByRole("combobox", { name: "Direction" });
  const quota = vi.spyOn(Storage.prototype, "setItem");
  const cookie = vi.spyOn(document, "cookie", "set").mockImplementation(() => {});
  try {
    expect(screen.getByRole("combobox", { name: "Color scheme" })).toHaveValue("System");
    expect(direction).toHaveValue("LTR");
    await user.click(direction);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(direction).toHaveValue("RTL");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    quota.mockImplementation(() => {
      throw new Error("quota");
    });
    await user.click(direction);
    await user.keyboard("{ArrowUp}{Enter}");
    expect(screen.getByText("Appearance settings could not be saved.")).toBeVisible();
    quota.mockRestore();
    cookie.mockRestore();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  } finally {
    quota.mockRestore();
    cookie.mockRestore();
    view.unmount();
  }
});

it("offers retry when both Web stores are unavailable and clears the message after recovery", async () => {
  const user = userEvent.setup();
  const blocked = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
    throw new Error("blocked");
  });
  const cookie = vi.spyOn(document, "cookie", "set").mockImplementation(() => {});
  const view = renderWithProviders(<VisualSettings />);
  try {
    await user.click(screen.getByRole("combobox", { name: "Motion" }));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByText("Appearance settings could not be saved.")).toBeVisible();
    blocked.mockRestore();
    cookie.mockRestore();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Motion" })).toHaveValue("Reduced");
  } finally {
    blocked.mockRestore();
    cookie.mockRestore();
    view.unmount();
  }
});
