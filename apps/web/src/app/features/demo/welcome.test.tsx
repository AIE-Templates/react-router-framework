import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Welcome } from "./welcome";

describe("Welcome", () => {
  it("links to the React Router docs", () => {
    render(<Welcome />);

    expect(screen.getByRole("link", { name: "React Router Docs" })).toHaveAttribute(
      "href",
      "https://reactrouter.com/docs",
    );
  });
});
