// @vitest-environment node
import { describe, expect, it } from "vitest";

import { withForwardedOrigin } from "./proxy.ts";

function forwarded(url: string, headers: Record<string, string>, init?: RequestInit) {
  return withForwardedOrigin(new Request(url, { ...init, headers }));
}

describe("withForwardedOrigin", () => {
  it("leaves requests without forwarded headers alone", () => {
    const request = new Request("http://app:3000/page");
    expect(withForwardedOrigin(request)).toBe(request);
  });

  it("takes the scheme and host, dropping the internal port", () => {
    const request = forwarded("http://app:3000/page?x=1", {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "example.com",
    });
    expect(request.url).toBe("https://example.com/page?x=1");
  });

  it("keeps a forwarded port and handles IPv6 hosts", () => {
    expect(forwarded("http://app:3000/", { "x-forwarded-host": "example.com:8443" }).url).toBe(
      "http://example.com:8443/",
    );
    expect(forwarded("http://app:3000/", { "x-forwarded-host": "[::1]" }).url).toBe("http://[::1]/");
  });

  it("uses the first of several values and ignores unknown schemes", () => {
    const request = forwarded("http://app:3000/", {
      "x-forwarded-proto": "ftp, https",
      "x-forwarded-host": "a.example.com, b.example.com",
    });
    expect(request.url).toBe("http://a.example.com/");
  });

  it("keeps the method, headers, body and abort signal", async () => {
    const controller = new AbortController();
    const request = forwarded(
      "http://app:3000/form",
      { "x-forwarded-proto": "https", "content-type": "text/plain" },
      { method: "POST", body: "hello", signal: controller.signal },
    );
    expect([request.method, request.headers.get("content-type"), await request.text()]).toEqual([
      "POST",
      "text/plain",
      "hello",
    ]);
    controller.abort();
    expect(request.signal.aborted).toBe(true);
  });
});
