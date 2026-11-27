import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Button } from "@mantine/core";
import { screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { renderWithProviders } from "~/testing/render";

const uiStyles = readFileSync(join(import.meta.dirname, "ui.css"), "utf8");

it("marks Select and Combobox dropdowns as no-drag in the global stylesheet", () => {
  // jsdom's CSSOM drops Electron's -webkit-app-region declaration.
  const selectors = [...uiStyles.matchAll(/([^{}]+)\{[^{}]*-webkit-app-region:\s*no-drag\s*;[^{}]*\}/g)]
    .flatMap((match) => match[1].split(","))
    .map((selector) => selector.trim());
  expect(selectors).toEqual(expect.arrayContaining([".mantine-Select-dropdown", ".mantine-Combobox-dropdown"]));
});

it.each(["preference", "media"] as const)("disables loading Button transitions for the reduced-motion %s", (source) => {
  const view = renderWithProviders(<Button loading>Save</Button>);
  const button = screen.getByRole("button", { name: "Save" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(uiStyles);
  const layer = [...sheet.cssRules].find((rule): rule is CSSLayerBlockRule => rule instanceof CSSLayerBlockRule)!;
  const media = [...layer.cssRules].find(
    (rule): rule is CSSMediaRule =>
      rule instanceof CSSMediaRule && rule.conditionText === "(prefers-reduced-motion: reduce)",
  )!;
  const root = document.documentElement;
  const previous = root.dataset.reducedMotion;
  if (source === "media") delete root.dataset.reducedMotion;
  else root.dataset.reducedMotion = "reduce";
  try {
    // The loader is still mounted while Mantine transitions out of its loading state.
    view.rerender(<Button loading={false}>Save</Button>);
    expect(button).not.toHaveAttribute("data-loading");
    const rules = [...(source === "media" ? media : layer).cssRules].filter(
      (rule): rule is CSSStyleRule =>
        rule instanceof CSSStyleRule &&
        rule.style.transitionDuration === "0s" &&
        rule.style.getPropertyPriority("transition-duration") === "important",
    );
    for (const part of [
      button,
      button.querySelector(".mantine-Button-inner")!,
      button.querySelector(".mantine-Button-loader")!,
    ]) {
      expect(rules.some((rule) => part.matches(rule.selectorText))).toBe(true);
    }
    // jsdom has no pseudo-element computed styles. Match the standalone ::before selector's originating button.
    const before = rules
      .flatMap((rule) => rule.selectorText.split(","))
      .filter((selector) => selector.trim().endsWith("::before"));
    expect(before.some((selector) => button.matches(selector.trim().slice(0, -"::before".length)))).toBe(true);
  } finally {
    if (previous === undefined) delete root.dataset.reducedMotion;
    else root.dataset.reducedMotion = previous;
  }
});
