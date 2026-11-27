// @vitest-environment node
import { createHash } from "node:crypto";

import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { cspMiddleware, defaultPolicy, inlineScriptHashes } from "./csp";

describe("defaultPolicy", () => {
  it.each([false, true])("allows HTTPS images, fonts and connections (development=%s)", (development) => {
    const policy = defaultPolicy(development);
    expect(policy["img-src"]).toEqual(["'self'", "https:", "data:", "blob:"]);
    expect(policy["font-src"]).toEqual(["'self'", "https:", "data:"]);
    expect(policy["connect-src"]).toEqual(
      development ? ["'self'", "https:", "wss:", "http:", "ws:"] : ["'self'", "https:", "wss:"],
    );
    expect(policy["script-src"]).toEqual(development ? ["'self'", "'unsafe-inline'"] : ["'self'"]);
  });
});

const hash = (body: string) => `'sha256-${createHash("sha256").update(body).digest("base64")}'`;

describe("inlineScriptHashes", () => {
  it("uses HTML attribute and text boundaries, including browser newline normalization", () => {
    const html =
      "<!-- <script>comment</script> --><textarea><script>text</script></textarea>" +
      '<script title="a > b" data-src="note">one\r\ntwo</script><script SRC></script>';
    expect(inlineScriptHashes(html)).toEqual([hash("one\ntwo")]);
  });

  it("hashes inline scripts and skips external ones", () => {
    const html = '<script src="/a.js"></script><script>window.x = 1;</script><SCRIPT type="module">go()</SCRIPT>';

    expect(inlineScriptHashes(html)).toEqual([hash("window.x = 1;"), hash("go()")]);
  });
});

describe("cspMiddleware", () => {
  const app = new Hono()
    .use(cspMiddleware(defaultPolicy(false)))
    .get("/page", (c) => c.html(`<script nonce="${c.var.cspNonce}">1</script>`))
    .get("/data", (c) => c.text("not a document"))
    .get("/own", (c) => c.html("<p/>", 200, { "Content-Security-Policy": "default-src 'none'" }));

  it("sets the policy with the request's nonce on HTML responses", async () => {
    const response = await app.request("/page");

    const header = response.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(header)?.[1];
    expect(nonce).toBeTruthy();
    expect(header).toContain(`script-src 'self' 'nonce-${nonce}'`);
    expect(header).toContain("frame-ancestors 'none'");
    expect(await response.text()).toBe(`<script nonce="${nonce}">1</script>`);
  });

  it("uses a fresh nonce per request", async () => {
    const [a, b] = await Promise.all([app.request("/page"), app.request("/page")]);
    expect(a.headers.get("content-security-policy")).not.toBe(b.headers.get("content-security-policy"));
  });

  it("leaves non-HTML responses and responses with their own policy alone", async () => {
    expect((await app.request("/data")).headers.has("content-security-policy")).toBe(false);
    expect((await app.request("/own")).headers.get("content-security-policy")).toBe("default-src 'none'");
  });
});
