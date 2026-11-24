import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { AppRoot } from "~/providers/app-root";

import { BasicShell } from "./app-shell";
import { WindowColumn, WindowLayout } from "./window-layout";

it("groups multiple body children and keeps drawers and nested headers outside the window band", () => {
  render(
    <AppRoot>
      <BasicShell>
        <WindowLayout>
          <WindowColumn primary header="Primary">
            <p>First</p>
            <p>Second</p>
            <WindowLayout>
              <WindowColumn primary header="Nested">
                Body
              </WindowColumn>
            </WindowLayout>
          </WindowColumn>
          <WindowColumn inWindowBand={false} header="Drawer">
            Tools
          </WindowColumn>
        </WindowLayout>
      </BasicShell>
    </AppRoot>,
  );
  expect(screen.getByText("First").parentElement).toHaveAttribute("data-window-column-body");
  expect(screen.getByText("Second").parentElement).toBe(screen.getByText("First").parentElement);
  expect(screen.getByText("Primary")).toHaveAttribute("data-window-drag");
  for (const name of ["Nested", "Drawer"]) expect(screen.getByText(name)).not.toHaveAttribute("data-window-drag");
});
