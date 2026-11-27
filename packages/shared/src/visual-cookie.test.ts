import { expect, it } from "vitest";

import { cookieName } from "./app-identity.ts";
import { serializeVisualCookie } from "./visual-cookie.ts";

it.each([false, true])("serializes the complete visual cookie (secure: %s)", (secure) => {
  expect(serializeVisualCookie('{"id":"a;b"}', secure)).toBe(
    cookieName("visual") +
      "=%7B%22id%22%3A%22a%3Bb%22%7D; Path=/; SameSite=Lax; Max-Age=31536000" +
      (secure ? "; Secure" : ""),
  );
});
