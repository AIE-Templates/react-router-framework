import type { Session, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { Logger } from "./log.ts";
import { installPermissionPolicy, isPermitted } from "./permissions.ts";

const source = { isMainFrame: true, requestingUrl: "app://app/page?token=secret" };

function contents(url = "app://app/", destroyed = false): WebContents {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Fake only the WebContents members used by the policy.
  return { isDestroyed: () => destroyed, mainFrame: { url } } as WebContents;
}

function setup() {
  const session = {
    setPermissionRequestHandler: vi.fn<Session["setPermissionRequestHandler"]>(),
    setPermissionCheckHandler: vi.fn<Session["setPermissionCheckHandler"]>(),
    setDevicePermissionHandler: vi.fn<Session["setDevicePermissionHandler"]>(),
  };
  const log = {
    debug: vi.fn<Logger["debug"]>(),
    info: vi.fn<Logger["info"]>(),
    warn: vi.fn<Logger["warn"]>(),
    error: vi.fn<Logger["error"]>(),
  };
  installPermissionPolicy(session, log);
  return {
    session,
    log,
    request: session.setPermissionRequestHandler.mock.calls[0][0]!,
    check: session.setPermissionCheckHandler.mock.calls[0][0]!,
    device: session.setDevicePermissionHandler.mock.calls[0][0]!,
  };
}

describe("permission policy", () => {
  it("allows only clipboard writing and fullscreen by the app's main document", () => {
    for (const permission of ["clipboard-sanitized-write", "fullscreen"]) {
      expect(isPermitted(permission, source)).toBe(true);
      expect(isPermitted(permission, { ...source, isMainFrame: false })).toBe(false);
      expect(isPermitted(permission, { isMainFrame: true })).toBe(false);
      for (const requestingUrl of ["https://app/", "app://other/", "about:blank", "invalid"]) {
        expect(isPermitted(permission, { ...source, requestingUrl })).toBe(false);
      }
    }
    for (const permission of [
      "notifications",
      "media",
      "display-capture",
      "clipboard-read",
      "automatic-fullscreen",
      "unknown",
    ]) {
      expect(isPermitted(permission, source)).toBe(false);
    }
  });

  it("requires both a trusted initiator and a permitted external target", () => {
    for (const externalURL of ["https://example.com/", "http://example.com/", "mailto:user@example.com"]) {
      expect(isPermitted("openExternal", { ...source, externalURL })).toBe(true);
      expect(isPermitted("openExternal", { ...source, externalURL, isMainFrame: false })).toBe(false);
    }
    for (const externalURL of [undefined, "file:///tmp/test", "javascript:alert(1)", "app://app/", "invalid"]) {
      expect(isPermitted("openExternal", { ...source, externalURL })).toBe(false);
    }
  });
});

describe("installed session handlers", () => {
  it("installs all three handlers and applies the allowlist to both requests and checks", () => {
    const { session, request, check } = setup();
    for (const setter of Object.values(session)) expect(setter).toHaveBeenCalledTimes(1);
    for (const permission of ["clipboard-sanitized-write", "fullscreen", "notifications", "media"] as const) {
      const callback = vi.fn<(allowed: boolean) => void>();
      request(contents(), permission, callback, source);
      const allowed = permission === "clipboard-sanitized-write" || permission === "fullscreen";
      expect(callback).toHaveBeenCalledExactlyOnceWith(allowed);
      expect(check(contents(), permission, "app://app", source)).toBe(allowed);
    }
  });

  it("rejects subframes, workers, missing URLs, remote origins and retired documents", () => {
    const { request, check } = setup();
    for (const page of [contents("https://example.com/"), contents("app://app/", true)]) {
      const callback = vi.fn<(allowed: boolean) => void>();
      request(page, "clipboard-sanitized-write", callback, source);
      expect(callback).toHaveBeenCalledExactlyOnceWith(false);
      expect(check(page, "clipboard-sanitized-write", "app://app", source)).toBe(false);
    }
    const callback = vi.fn<(allowed: boolean) => void>();
    const subframe = { ...source, isMainFrame: false };
    request(contents(), "clipboard-sanitized-write", callback, subframe);
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
    expect(check(contents(), "clipboard-sanitized-write", "app://app", subframe)).toBe(false);
    expect(check(null, "clipboard-sanitized-write", "app://app", source)).toBe(false);
    expect(check(contents(), "clipboard-sanitized-write", "app://app", { isMainFrame: true })).toBe(false);
    expect(check(contents(), "clipboard-sanitized-write", "https://example.com", source)).toBe(false);
    expect(
      check(contents(), "clipboard-sanitized-write", "app://app", { ...source, requestingUrl: "https://example.com/" }),
    ).toBe(false);
  });

  it("reads openExternal's externalURL from request details and denies targetless checks", () => {
    const { request, check } = setup();
    const callback = vi.fn<(allowed: boolean) => void>();
    request(contents(), "openExternal", callback, { ...source, externalURL: "https://example.com/" });
    expect(callback).toHaveBeenCalledExactlyOnceWith(true);
    expect(check(contents(), "openExternal", "app://app", source)).toBe(false);
  });

  it("denies devices and records only permission names, never URLs or device identifiers", () => {
    const { request, device, log } = setup();
    request(contents(), "media", vi.fn<(allowed: boolean) => void>(), source);
    for (const deviceType of ["hid", "serial", "usb"] as const) {
      expect(
        device({
          deviceType,
          origin: source.requestingUrl,
          device: { deviceId: "secret-id", name: "secret-device", vendorId: 1, productId: 2, collections: [] },
        }),
      ).toBe(false);
    }
    expect(log.warn.mock.calls).toEqual(
      ["media", "hid", "serial", "usb"].map((permission) => [{ permission }, "denied renderer permission"]),
    );
  });
});
