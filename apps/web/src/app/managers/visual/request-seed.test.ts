import { visualRecordKernel } from "@repo/shared";
import { expect, it, vi } from "vitest";

import { visualCookie } from "~/config/visual-cookie";

import { readVisualRequestSeed } from "./request-seed";

it("reads the request cookie only in SSR mode", () => {
  const record = { version: 1, stamp: { t: 1, id: "a" }, preferences: { direction: "rtl" } } as const;
  const request = new Request("https://example.test", {
    headers: { Cookie: visualCookie.name + "=" + encodeURIComponent(visualRecordKernel.encode(record)) },
  });
  expect(readVisualRequestSeed(request)).toEqual(record);
  vi.stubGlobal("APP_SSR", false);
  const read = vi.spyOn(request.headers, "get");
  try {
    expect(readVisualRequestSeed(request)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    vi.unstubAllGlobals();
  }
});
