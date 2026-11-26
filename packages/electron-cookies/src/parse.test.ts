import { describe, expect, it } from "vitest";

import { defaultPath, MAX_AGE_S, parseCookieDate, parseSetCookie } from "./parse.ts";
const now = Date.UTC(2026, 9, 28, 12, 0, 0);
const context = { requestPath: "/account/login", now, serverDate: undefined as number | undefined };
const parse = (header: string, overrides: Partial<typeof context> = {}) =>
  parseSetCookie(header, { ...context, ...overrides });

function set(header: string, overrides: Partial<typeof context> = {}) {
  const parsed = parse(header, overrides);
  if (!parsed.ok) throw new Error(`expected a set: ${JSON.stringify(parsed)}`);
  return parsed.cookie;
}

function rejected(header: string, overrides: Partial<typeof context> = {}): string {
  const parsed = parse(header, overrides);
  if (parsed.ok) throw new Error(`expected a rejection: ${JSON.stringify(parsed)}`);
  return parsed.reason;
}

describe("parseSetCookie", () => {
  it("parses name, value and attributes, case-insensitively and with whitespace trimmed", () => {
    expect(set(" sid = abc ; path=/ ; SECURE; HttpOnly; SameSite=Strict; Partitioned; Priority=High")).toEqual({
      name: "sid",
      value: "abc",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "strict",
    });
    expect(set("a=1").sameSite).toBe("unspecified");
    expect(set("a=1; SameSite=lax").sameSite).toBe("lax");
    expect(set("a=1; SameSite=None; Secure").sameSite).toBe("no_restriction");
    expect(set("a=1; SameSite=bogus").sameSite).toBe("unspecified");
  });

  it("keeps the value as is: quotes, '=' and an empty value", () => {
    expect(set('a="quoted"').value).toBe('"quoted"');
    expect(set("a=b=c").value).toBe("b=c");
    expect(set("a=").value).toBe("");
  });

  it("rejects isolated UTF-16 surrogates in the cookie pair but accepts scalar values", () => {
    expect(rejected("high=\ud800")).toBe("invalid Unicode cookie pair");
    expect(rejected("bad\udfff=value")).toBe("invalid Unicode cookie pair");
    expect(set("valid🍪=�; Unknown=\ud800")).toMatchObject({ name: "valid🍪", value: "�" });
  });

  it.each(["bare", "=bare"])("accepts a nameless cookie: %s", (header) => {
    expect(set(header)).toMatchObject({ name: "", value: "bare" });
  });

  it.each(["a=b\u0001c", "a=b\nc", "a=b\tc", "a=b; Path=/a\tb", "a=b; Unknown=f\tg", "a=b; Unknown\x7f=x"])(
    "rejects an embedded control in %j",
    (header) => {
      expect(rejected(header)).toBe("control character");
    },
  );

  it("rejects an empty name and value even on an expired cookie", () => {
    expect(rejected("=; Max-Age=0")).toBe("empty cookie");
  });

  it("normalizes only the final Domain and rejects empty labels before the host", () => {
    expect(set("a=1; Domain=..bad; Domain=.ExAmPle.TeSt").domain).toBe("example.test");
    expect(set("a=1; Domain=")).not.toHaveProperty("domain");
    expect(rejected("a=1; Domain=.")).toBe("invalid Domain");
    expect(rejected("a=1; Domain=..example.test")).toBe("invalid Domain");
  });

  it("discards separator whitespace before checking controls", () => {
    expect(set("a\t=\tb\t;\tPath\t=\t/x\t")).toMatchObject({ name: "a", value: "b", path: "/x" });
  });

  it("ignores attribute values over 1024 bytes", () => {
    expect(set(`a=1; Path=/${"p".repeat(1023)}`).path).toBe(`/${"p".repeat(1023)}`);
    expect(set(`a=1; Path=/${"p".repeat(1024)}`).path).toBe("/account");
  });

  describe("Path", () => {
    it("defaults to the request path's directory", () => {
      expect(set("a=1").path).toBe("/account");
      expect(set("a=1", { requestPath: "/" }).path).toBe("/");
      expect(set("a=1", { requestPath: "/login" }).path).toBe("/");
      expect(set("a=1", { requestPath: "/a/b/" }).path).toBe("/a/b");
    });

    it("uses the attribute when it starts with '/', the default otherwise", () => {
      expect(set("a=1; Path=/api").path).toBe("/api");
      expect(set("a=1; Path=").path).toBe("/account");
      expect(set("a=1; Path=relative").path).toBe("/account");
      // The last Path wins, even when it is invalid.
      expect(set("a=1; Path=/x; Path=y").path).toBe("/account");
    });

    it("computes the default path per RFC 6265bis 5.1.4", () => {
      expect(defaultPath("")).toBe("/");
      expect(defaultPath("no-slash")).toBe("/");
      expect(defaultPath("/")).toBe("/");
      expect(defaultPath("/a")).toBe("/");
      expect(defaultPath("/a/b")).toBe("/a");
      expect(defaultPath("/a/b/c")).toBe("/a/b");
    });
  });

  describe("Expires and Max-Age", () => {
    it("makes a session cookie without either, or with an unparsable one", () => {
      expect(set("a=1").expirationDate).toBeUndefined();
      expect(set("a=1; Expires=tomorrow").expirationDate).toBeUndefined();
      expect(set("a=1; Max-Age=soon").expirationDate).toBeUndefined();
      expect(set("a=1; Max-Age=1.5").expirationDate).toBeUndefined();
    });

    it.each([
      ["+600", now / 1000 + 600],
      ["+0", 1],
      ["+-1", undefined],
      [" +600\t", now / 1000 + 600],
      ["+ 600", undefined],
      ["99999999999999999999", now / 1000 + MAX_AGE_S],
      ["-99999999999999999999", 1],
      ["9223372036854775806x", undefined],
      ["+9223372036854775807x", now / 1000 + MAX_AGE_S],
      ["-9223372036854775808x", 1],
      ["99999999999999999999x", now / 1000 + MAX_AGE_S],
    ] as const)("matches Chromium's signed Max-Age conversion for %j", (raw, expiry) => {
      expect(set("a=1; Max-Age=" + raw).expirationDate).toBe(expiry);
    });

    it("sets the expiry from Max-Age, which wins over Expires in any order", () => {
      expect(set("a=1; Max-Age=3600").expirationDate).toBe(now / 1000 + 3600);
      expect(set("a=1; Max-Age=60; Expires=Wed, 28 Oct 2026 13:00:00 GMT").expirationDate).toBe(now / 1000 + 60);
      expect(set("a=1; Expires=Wed, 28 Oct 2026 13:00:00 GMT; Max-Age=60").expirationDate).toBe(now / 1000 + 60);
      expect(set("a=1; Expires=Wed, 28 Oct 2026 13:00:00 GMT").expirationDate).toBe(now / 1000 + 3600);
    });

    it("keeps the full Max-Age lifetime for a write near the end of a second", () => {
      expect(set("a=1; Max-Age=1", { now: now + 999 }).expirationDate).toBe((now + 1999) / 1000);
    });

    it("caps the lifetime at 400 days", () => {
      expect(set("a=1; Max-Age=999999999").expirationDate).toBe(now / 1000 + MAX_AGE_S);
      expect(set("a=1; Expires=Fri, 31 Dec 9999 23:59:59 GMT").expirationDate).toBe(now / 1000 + MAX_AGE_S);
    });

    it.each([
      "Max-Age=0",
      "Max-Age=-1",
      "Expires=01 Jan 1970 00:00:00",
      "Expires=28 Oct 1600 12:00:00",
      "Expires=28 Oct 0001 12:00:00",
    ])("encodes %s as a past expiry", (attr) => {
      expect(set("a=; " + attr).expirationDate).toBe(1);
    });

    it("applies the last attribute, then prefers a valid Max-Age to a clock-adjusted Expires", () => {
      const ctx = { serverDate: now - 86400000 };
      const expires = "Expires=27 Oct 2026 13:00:00 GMT";
      expect(set("a=1; Max-Age=30; Max-Age=10; " + expires, ctx).expirationDate).toBe(now / 1000 + 10);
      expect(set("a=1; Max-Age=30; Max-Age=bad; " + expires, ctx).expirationDate).toBe(now / 1000 + 3600);
      expect(set("a=1; " + expires + "; Expires=bad", ctx).expirationDate).toBeUndefined();
    });
  });

  it.each(["/文档", "/a b", "/a/../b", "/a\\b", "/a?x=1", "/a|b"])(
    "rejects an effective noncanonical explicit Path=%s",
    (path) => {
      expect(rejected("a=1; Path=" + path)).toBe("noncanonical Path");
      expect(set("a=1; Path=" + path + "; Path=relative", { requestPath: "/a|b/login" }).path).toBe("/a|b");
    },
  );

  it.each(["__Host-a", "__host-http-a"])("requires explicit Path=/ for %s even at the root", (name) => {
    expect(rejected(name + "=v; Secure; HttpOnly", { requestPath: "/login" })).toContain("explicit Path=/");
    expect(set(name + "=v; Secure; HttpOnly; Path=/").path).toBe("/");
  });

  it("requires explicit Secure for Partitioned and ignores oversized attributes by UTF-8 byte length", () => {
    expect(rejected("sid=v; Partitioned")).toContain("Partitioned");
    expect(set("sid=v; Partitioned; Secure").secure).toBe(true);
    expect(set("sid=v; Domain=" + "文".repeat(342))).not.toHaveProperty("domain");
  });
});
describe("parseCookieDate", () => {
  it("parses the common formats", () => {
    const expected = Date.UTC(2026, 9, 28, 13, 5, 9);
    expect(parseCookieDate("Wed, 28 Oct 2026 13:05:09 GMT")).toBe(expected);
    expect(parseCookieDate("Wednesday, 28-Oct-26 13:05:09 GMT")).toBe(expected);
    expect(parseCookieDate("Wed Oct 28 13:05:09 2026")).toBe(expected);
    expect(parseCookieDate("28 october 2026 13:5:9")).toBe(expected);
  });

  it("maps two-digit years per RFC 6265bis", () => {
    expect(parseCookieDate("01 Jan 70 00:00:00")).toBe(Date.UTC(1970, 0, 1));
    expect(parseCookieDate("01 Jan 69 00:00:00")).toBe(Date.UTC(2069, 0, 1));
  });

  it("rejects missing parts, out-of-range values and dates that do not exist", () => {
    for (const value of [
      "",
      "Wed, 28 Oct 2026",
      "28 Oct 2026 24:00:00",
      "28 Oct 2026 12:60:00",
      "32 Oct 2026 12:00:00",
      "30 Feb 2026 12:00:00",
      "28 Foo 2026 12:00:00",
    ]) {
      expect([value, parseCookieDate(value)]).toEqual([value, undefined]);
    }
  });
});
