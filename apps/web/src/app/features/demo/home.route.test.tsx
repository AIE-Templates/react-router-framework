import { fireEvent, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { expect, it } from "vitest";

import { renderWithProviders } from "~/testing/render";

import Deals from "./deals.route";
import DemoLayout from "./demo.layout";
import Home from "./home.route";
import SalesReport from "./sales-report.route";

const area = () => screen.getByRole("main").closest("[data-area-id]");

it("uses client navigation while preserving the basename, query settings and draft", async () => {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        Component: DemoLayout,
        children: [
          { index: true, Component: Home },
          { path: "deals", Component: Deals },
          { path: "reports/sales", Component: SalesReport },
        ],
      },
    ],
    {
      basename: "/workspace",
      initialEntries: ["/workspace/?header=standalone&keep=1"],
    },
  );
  renderWithProviders(<RouterProvider router={router} />);
  const draft = screen.getByRole("textbox", { name: "Follow-up note" });
  fireEvent.change(draft, { target: { value: "Unsaved draft" } });
  const home = screen.getByRole("link", { name: "Sales" });
  expect(home).toHaveAttribute("href", "/workspace?header=standalone&keep=1&shell=navigation");
  for (const [name, path] of [
    ["Settings", "settings"],
    ["Chat demo", "chat"],
  ]) {
    const link = screen.getByRole("link", { name });
    expect(link).toHaveAttribute("href", "/workspace/" + path);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener");
  }
  fireEvent.click(home);
  await waitFor(() => expect(router.state.location.search).toContain("shell=navigation"));
  expect(draft).toHaveValue("Unsaved draft");
  expect(screen.getAllByRole("main")).toHaveLength(1);
  if (!screen.queryByRole("link", { name: "Deals" })) fireEvent.click(screen.getByRole("button", { name: "Sidebar" }));
  fireEvent.click(screen.getByRole("link", { name: "Deals" }));
  expect(await screen.findByRole("heading", { name: "Deals" })).toBeInTheDocument();
  expect(area()).toHaveAttribute("data-area-id", "sales");
  fireEvent.click(screen.getByRole("link", { name: "Reports" }));
  expect(await screen.findByRole("heading", { name: "Sales report" })).toBeInTheDocument();
  expect(area()).toHaveAttribute("data-area-id", "reports");
  fireEvent.change(screen.getByRole("combobox", { name: "App shell" }), { target: { value: "basic" } });
  await waitFor(() => expect(area()).toHaveAttribute("data-area-id", "crm"));
  expect(screen.getByRole("heading", { name: "Sales report" })).toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "App areas" })).toBeNull();
  if (!screen.queryByRole("link", { name: "Deals" })) fireEvent.click(screen.getByRole("button", { name: "Sidebar" }));
  fireEvent.click(screen.getByRole("link", { name: "Deals" }));
  expect(await screen.findByRole("heading", { name: "Deals" })).toBeInTheDocument();
  expect(area()).toHaveAttribute("data-area-id", "crm");
  fireEvent.click(screen.getByRole("link", { name: "Leads" }));
  expect(await screen.findByDisplayValue("Unsaved draft")).toBeInTheDocument();
});
