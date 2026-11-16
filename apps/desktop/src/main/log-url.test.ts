import { describe, expect, it } from "vitest";

import { redactLogUrls, safeUrl } from "./log-url.ts";

describe("URL log fields", () => {
  it("keeps useful paths while dropping credentials, query and fragment", () => {
    const url = "https://user:password@example.test:8080/a.js?token=secret#private";
    expect(safeUrl(url)).toBe("https://example.test:8080/a.js");
    expect(safeUrl(url, "path")).toBe("/a.js");
    expect(safeUrl("app://app/a.data?secret=value")).toBe("app://app/a.data");
    expect(safeUrl("file:///tmp/file.js?token=secret")).toBe("file:///tmp/file.js");
  });

  it("does not echo malformed addresses or opaque payloads", () => {
    expect(safeUrl("token=secret")).toBe("(invalid URL)");
    for (const scheme of ["data", "javascript", "blob", "mailto"]) {
      expect(safeUrl(`${scheme}:private-payload`)).toBe(`(${scheme}: URL)`);
    }
  });

  it("bounds long URL fields after removing their private parts", () => {
    for (const url of [`app://app/${"a".repeat(1000)}?secret=value`, `${"x".repeat(1000)}:secret`]) {
      const value = safeUrl(url);
      expect(value.length).toBeLessThanOrEqual(512);
      expect(value).not.toContain("secret");
    }
  });

  it("redacts absolute URLs inside diagnostics without removing surrounding context", () => {
    expect(redactLogUrls("Failed https://user:pa)ss@example.test/path?token=one(two)three&other=private.")).toBe(
      "Failed https://example.test/path.",
    );
    expect(redactLogUrls('Fetch "https://user:password@example.test/path?token=secret#private" failed')).toBe(
      'Fetch "https://example.test/path" failed',
    );
    expect(
      redactLogUrls("at handler (app://app/entry.js?token=secret:1:2)\n    at retry (file:///app/main.cjs:10:2)"),
    ).toBe("at handler (app://app/entry.js)\n    at retry (file:///app/main.cjs:10:2)");
  });
});
