import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";

import { VisualManagerContext } from "~/managers/visual/context";
import { createVisualManager } from "~/managers/visual/manager";

import { AppUiProvider } from "./app-ui-provider";

afterEach(() => {
  act(() => {
    modals.closeAll();
    notifications.clean();
  });
  localStorage.clear();
});

function renderUi(manager = createVisualManager({ host: window })) {
  render(
    <VisualManagerContext.Provider value={manager}>
      <AppUiProvider>
        <main />
      </AppUiProvider>
    </VisualManagerContext.Provider>,
  );
  return manager;
}

it("serves the imperative modal and notification APIs from the UI slot", async () => {
  renderUi();
  let confirmed = false;
  act(() => {
    modals.openConfirmModal({
      title: "Confirm action",
      labels: { confirm: "Confirm", cancel: "Cancel" },
      onConfirm: () => {
        confirmed = true;
        notifications.show({ title: "Done", message: "Action completed" });
      },
    });
  });
  expect(await screen.findByRole("dialog", { name: "Confirm action" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(confirmed).toBe(true);
  expect(await screen.findByText("Action completed")).toBeInTheDocument();
});

it("follows reduced motion and direction for notifications", async () => {
  const manager = renderUi();
  act(() => {
    manager.actions.setReducedMotionPreference("reduce");
    manager.actions.setDirection("rtl");
    notifications.show({ message: "Saved" });
  });
  const notification = (await screen.findByText("Saved")).closest<HTMLElement>(".mantine-Notifications-notification");
  expect(notification?.style.transitionDuration).toBe("0ms, 0ms, 0ms");
  expect(notification?.closest("[data-position]")).toHaveAttribute("data-position", "bottom-left");
});
