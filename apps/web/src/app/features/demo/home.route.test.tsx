import { fireEvent, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { expect, it } from "vitest";

import { renderWithProviders } from "~/testing/render";

import Home from "./home.route";

it("uses client navigation while preserving the basename, query settings and draft", async () => {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        Component: Home,
      },
    ],
    {
      basename: "/workspace",
      initialEntries: ["/workspace/?header=standalone&keep=1"],
    },
  );
  renderWithProviders(<RouterProvider router={router} />);
  const draft = screen.getByRole("textbox", { name: "Module draft" });
  fireEvent.change(draft, { target: { value: "Unsaved draft" } });
  const home = screen.getByRole("link", { name: "Home" });
  expect(home).toHaveAttribute("href", "/workspace?header=standalone&keep=1&shell=navigation");
  fireEvent.click(home);
  await waitFor(() => expect(router.state.location.search).toContain("shell=navigation"));
  expect(draft).toHaveValue("Unsaved draft");
  expect(screen.getAllByRole("main")).toHaveLength(1);
});
