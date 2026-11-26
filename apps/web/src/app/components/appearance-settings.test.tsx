import { fireEvent, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { visualCookie } from "~/config/visual-cookie";
import { renderWithProviders } from "~/testing/render";

import { VisualSettings } from "./appearance-settings";

it("keeps effective defaults selected and reports only a failed store or complete loss of persistence", () => {
  const view = renderWithProviders(<VisualSettings />);
  const direction = screen.getByLabelText("Direction");
  const quota = vi.spyOn(Storage.prototype, "setItem");
  const cookie = vi.spyOn(document, "cookie", "set").mockImplementation(() => {});
  try {
    expect(screen.getByLabelText("Color scheme")).toHaveValue("auto");
    expect(direction).toHaveValue("ltr");
    fireEvent.change(direction, { target: { value: "rtl" } });
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    quota.mockImplementation(() => {
      throw new Error("quota");
    });
    fireEvent.change(direction, { target: { value: "ltr" } });
    expect(screen.getByText("Appearance settings could not be saved.")).toBeVisible();
    quota.mockRestore();
    cookie.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  } finally {
    quota.mockRestore();
    cookie.mockRestore();
    view.unmount();
    localStorage.clear();
    document.cookie = visualCookie.name + "=; Path=/; Max-Age=0";
  }
});

it("offers retry when both Web stores are unavailable and clears the message after recovery", () => {
  const blocked = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
    throw new Error("blocked");
  });
  const cookie = vi.spyOn(document, "cookie", "set").mockImplementation(() => {});
  const view = renderWithProviders(<VisualSettings />);
  try {
    fireEvent.change(screen.getByLabelText("Motion"), { target: { value: "reduce" } });
    expect(screen.getByText("Appearance settings could not be saved.")).toBeVisible();
    blocked.mockRestore();
    cookie.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByLabelText("Motion")).toHaveValue("reduce");
  } finally {
    blocked.mockRestore();
    cookie.mockRestore();
    view.unmount();
    localStorage.clear();
    document.cookie = visualCookie.name + "=; Path=/; Max-Age=0";
  }
});
