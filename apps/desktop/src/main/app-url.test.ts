import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

import { APP_HOST, APP_ORIGIN, APP_SCHEME, isAppUrl } from "./app-url.ts";

describe("application origin", () => {
  it("preserves the existing browser storage identity", () => {
    expect({ APP_SCHEME, APP_HOST, APP_ORIGIN }).toEqual({
      APP_SCHEME: "app",
      APP_HOST: "app",
      APP_ORIGIN: "app://app",
    });
    expect(isAppUrl(`${APP_ORIGIN}/chat/1?view=details#message`)).toBe(true);
    expect(isAppUrl(APP_ORIGIN)).toBe(true);
  });

  it.each(["app://evil/", "app://app.evil/", "app://app:123/", "https://app/", "file:///app", "invalid"])(
    "rejects other origins: %s",
    (url) => expect(isAppUrl(url)).toBe(false),
  );
});

it("uses the configured application scheme throughout desktop runtime code", () => {
  const root = resolve(import.meta.dirname, "..");
  const violations = globSync("**/*.{ts,tsx}", {
    cwd: root,
    exclude: ["**/*.test.{ts,tsx}", "main/app-url.ts"],
  }).filter((file) => {
    const source = readFileSync(resolve(root, file), "utf8");
    const { comments } = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
    // Remove only parser-identified comments, including when a quoted URL contains comment delimiters.
    let code = source;
    for (const comment of (comments ?? []).toReversed()) {
      code = code.slice(0, comment.start) + " " + code.slice(comment.end);
    }
    return /\bapp:\/\/|["'`]app:?["'`]/.test(code);
  });
  expect(violations).toEqual([]);
});
