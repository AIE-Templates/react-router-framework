import { describe, expect, it } from "vitest";

import { isExternalUrl } from "./window.ts";

describe("url helpers", () => {
  it("only permits web and mail links to external applications", () => {
    for (const url of ["http://example.test", "https://example.test", "mailto:person@example.test"]) {
      expect(isExternalUrl(url)).toBe(true);
    }
    for (const url of ["file:///private/example", "javascript:alert(1)", "app://app/", "invalid"]) {
      expect(isExternalUrl(url)).toBe(false);
    }
  });
});
