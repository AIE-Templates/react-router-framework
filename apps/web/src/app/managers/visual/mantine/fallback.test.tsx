import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { TextInput } from "@mantine/core";
import { within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";

import { VisualManagerProvider } from "~/managers/visual/provider";

import { createVisualFallbackCss } from "./fallback";
import { VisualMantineProvider } from "./provider";

const inputStyles = readFileSync(createRequire(import.meta.url).resolve("@mantine/core/styles/Input.css"), "utf8");

it("keeps a server-rendered default input's surface, border and focus border when prepaint cannot run", () => {
  const markup = renderToString(
    <VisualManagerProvider>
      <VisualMantineProvider>
        <TextInput label="Note" />
      </VisualMantineProvider>
    </VisualManagerProvider>,
  );
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(createVisualFallbackCss());
  const layer = [...sheet.cssRules].find((rule): rule is CSSLayerBlockRule => rule instanceof CSSLayerBlockRule)!;
  // jsdom computes unlayered styles. Use the generated layer's rules with the installed Input stylesheet.
  const style = document.createElement("style");
  style.textContent = inputStyles + [...layer.cssRules].map((rule) => rule.cssText).join("\n");
  const container = document.createElement("div");
  container.innerHTML = markup;
  document.head.append(style);
  document.body.append(container);
  try {
    const input = within(container).getByRole("textbox", { name: "Note" });
    const variables = getComputedStyle(input);
    expect(variables.getPropertyValue("--input-bd")).toBe("var(--app-color-input)");
    expect(variables.getPropertyValue("--input-bg")).toBe("var(--app-color-card)");
    expect(variables.getPropertyValue("--input-bd-focus")).toBe("var(--app-color-ring)");
    input.focus();
    expect(getComputedStyle(input).getPropertyValue("--input-bd")).toBe("var(--input-bd-focus)");
  } finally {
    container.remove();
    style.remove();
  }
});
