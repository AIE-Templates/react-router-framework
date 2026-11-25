import { describe, expect, it } from "vitest";

import { prepareCookieFrame, selectCookieInstallation } from "./frame.ts";
import type { CookieFrame } from "./types.ts";

const appOrigin = "xxx-app://shell";
const href = appOrigin + "/nested/start";
const main: CookieFrame = { origin: appOrigin, protocol: "xxx-app:", href, isMainFrame: true };

describe("isolated-world cookie installation", () => {
  it("DC-15/18/20 records on the isolated window and only consults an accessible srcdoc parent", () => {
    const parent = {
      origin: appOrigin,
      location: { protocol: main.protocol, href },
      get parent(): never {
        throw new Error("parent unavailable");
      },
    };
    prepareCookieFrame(appOrigin, parent, true);
    parent.location.href += "/later";
    const child = { origin: appOrigin, location: { protocol: "about:", href: "about:srcdoc" }, parent };
    expect(prepareCookieFrame(appOrigin, child, false).creationUrl).toBe(href);
    expect(prepareCookieFrame(appOrigin, { ...child, parent: child }, false).creationUrl).toBe(href);
    const unavailable = {
      ...child,
      get parent(): never {
        throw new Error("cross-origin parent");
      },
    };
    expect(prepareCookieFrame(appOrigin, unavailable, false)).toEqual({
      cookieApi: false,
      fetch: true,
      creationUrl: null,
    });
    const opaque = {
      ...child,
      origin: "null",
      get parent(): never {
        throw new Error("must not inspect");
      },
    };
    expect(prepareCookieFrame(appOrigin, opaque, false).fetch).toBe(false);
  });
  it.each([true, false])("DC-15/18/23 captures an app document, isMainFrame=%s", (isMainFrame) => {
    const frame = { ...main, isMainFrame };
    const snapshot = selectCookieInstallation(appOrigin, frame);
    frame.href += "/later";
    expect(snapshot).toEqual({ cookieApi: true, fetch: true, creationUrl: href });
  });

  it("DC-18/21 nested srcdoc inherits the parent's original creation URL", () => {
    const parent = selectCookieInstallation(appOrigin, main);
    const frame = { ...main, protocol: "about:", href: "about:srcdoc", isMainFrame: false };
    const child = selectCookieInstallation(appOrigin, { ...frame, parentCreationUrl: parent.creationUrl });
    expect(child).toEqual(parent);
    expect(selectCookieInstallation(appOrigin, { ...frame, parentCreationUrl: child.creationUrl })).toEqual(parent);
    expect(selectCookieInstallation(appOrigin, frame)).toEqual({ cookieApi: false, fetch: true, creationUrl: null });
  });

  it.each(["null", "https://shell", "file-assets://shell", "xxx-app://shell.example"])(
    "DC-20/22 skips an opaque or foreign effective origin %s even with an app href",
    (origin) => {
      expect(selectCookieInstallation(appOrigin, { ...main, origin })).toEqual({
        cookieApi: false,
        fetch: false,
        creationUrl: null,
      });
    },
  );

  it("DC-21 only patches fetch in blob and leaves about:blank alone", () => {
    const frame = { ...main, isMainFrame: false, parentCreationUrl: href };
    expect(selectCookieInstallation(appOrigin, { ...frame, protocol: "blob:", href: "blob:" + href })).toEqual({
      cookieApi: false,
      fetch: true,
      creationUrl: null,
    });
    expect(selectCookieInstallation(appOrigin, { ...frame, protocol: "about:", href: "about:blank" })).toEqual({
      cookieApi: false,
      fetch: false,
      creationUrl: null,
    });
  });
});
