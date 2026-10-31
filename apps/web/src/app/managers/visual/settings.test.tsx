import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";

import { AppUiProvider } from "../../providers/app-ui-provider";
import { VisualManagerContext } from "./context";
import { createVisualManager } from "./manager";
import { VisualSettings } from "./settings";

afterEach(() => {
  act(() => {
    modals.closeAll();
    notifications.clean();
  });
  localStorage.clear();
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
  await screen.findByRole("dialog", { name: "Reset appearance?" });
  await user.click(screen.getByRole("button", { name: "Reset" }));

  expect(manager.getSnapshot().preferences.direction).toBe("ltr");
  expect(await screen.findByText("System defaults restored.")).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Reset appearance?" })).not.toBeInTheDocument());
});
