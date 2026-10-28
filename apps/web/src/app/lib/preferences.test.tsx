import { type DesktopBridge, preferencesFromCookies, type Shell } from "@repo/shared";
import { act, render, screen } from "@testing-library/react";
import { createRoutesStub, RouterContextProvider, useLoaderData } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppRoot } from "../providers/app-root";
import {
  getPreference,
  PreferenceError,
  preferencesContext,
  requestPreferences,
  useSetPreference,
  writePreference,
} from "./preferences";

const desktopShell: Extract<Shell, { kind: "desktop" }> = { kind: "desktop", platform: "darwin", osVersion: "26" };

function fakeBridge(prefs: Record<string, unknown> = {}): DesktopBridge {
  return {
    platform: "darwin",
    version: "1",
    bootstrap: { protocolVersion: 1, shell: desktopShell, mode: "system-decorated" },
    subscribeWindowState: () => () => {},
    updateOverlayAppearance: async () => ({ status: "unsupported", reason: "system-decorated" }),
    setPref: vi.fn<DesktopBridge["setPref"]>(async (key, value) => {
      if (key === "rejected") return { status: "rejected", reason: "too-large" };
      prefs[key] = value;
      return { status: "applied" };
    }),
    removePref: vi.fn<DesktopBridge["removePref"]>(async (key) => {
      delete prefs[key];
      return { status: "applied" };
    }),
  };
}

/** A document stand-in that records cookie writes instead of applying them. */
function cookieRecorder(protocol = "http:") {
  const written: string[] = [];
  const doc = {
    location: { protocol },
    get cookie() {
      return "";
    },
    set cookie(value: string) {
      written.push(value);
    },
  };
  return { doc, written };
}

afterEach(() => {
  delete window.desktop;
  for (const name of Object.keys(preferencesFromCookies(document.cookie)))
    document.cookie = `pref-${name}=; Path=/; Max-Age=0`;
});

describe("getPreference", () => {
  it("reads this request's preferences, own keys only", () => {
    const context = new RouterContextProvider();
    context.set(preferencesContext, { theme: "dark", width: 280 });
    expect(getPreference(context, "theme")).toBe("dark");
    expect(getPreference(context, "width")).toBe(280);
    expect(getPreference(context, "missing")).toBeUndefined();
    expect(getPreference(context, "constructor")).toBeUndefined();
    expect(getPreference(new RouterContextProvider(), "theme")).toBeUndefined();
  });

  it("comes from cookies in the web shell and from x-desktop-prefs facts in the desktop shell", () => {
    const request = new Request("http://localhost/", { headers: { cookie: "pref-theme=%22light%22" } });
    expect(requestPreferences({ kind: "web" }, request)).toEqual({ theme: "light" });
    expect(requestPreferences(desktopShell, request, { prefs: { theme: "dark" } })).toEqual({ theme: "dark" });
    expect(requestPreferences(desktopShell, request)).toEqual({});
  });
});

describe("writePreference in the web shell", () => {
  it("writes a pref-* cookie the server reads back with the same type", async () => {
    await writePreference("web", "theme", "dark");
    await writePreference("web", "width", 280);
    expect(preferencesFromCookies(document.cookie)).toEqual({ theme: "dark", width: 280 });
    await writePreference("web", "theme", null);
    expect(preferencesFromCookies(document.cookie)).toEqual({ width: 280 });
  });

  it("sets Path, SameSite, a year's Max-Age, and Secure on https", async () => {
    const http = cookieRecorder();
    await writePreference("web", "theme", "dark", { doc: http.doc });
    expect(http.written).toEqual(["pref-theme=%22dark%22; Path=/; SameSite=Lax; Max-Age=31536000"]);
    const https = cookieRecorder("https:");
    await writePreference("web", "theme", null, { doc: https.doc });
    expect(https.written).toEqual(["pref-theme=; Path=/; SameSite=Lax; Max-Age=0; Secure"]);
  });

  it("rejects what the desktop shell would reject", async () => {
    await expect(writePreference("web", "bad key", 1)).rejects.toMatchObject({ reason: "invalid-key" });
    await expect(writePreference("web", "x", "y".repeat(2000))).rejects.toMatchObject({ reason: "invalid-value" });
    for (let i = 0; i < 4; i++) await writePreference("web", `k${i}`, "x".repeat(1000));
    await expect(writePreference("web", "k4", "x".repeat(1000))).rejects.toBeInstanceOf(PreferenceError);
  });

  it("rejects CJK and quote-heavy values whose cookie the browser would drop, before writing", async () => {
    const { doc, written } = cookieRecorder();
    await expect(writePreference("web", "k", "\u4e3b".repeat(600), { doc })).rejects.toMatchObject({
      reason: "too-large",
    });
    await expect(writePreference("web", "k", '"'.repeat(1024), { doc })).rejects.toMatchObject({ reason: "too-large" });
    expect(written).toEqual([]);
    // What is accepted is stored: the browser keeps it and reads it back.
    await writePreference("web", "locale", "\u4e3b".repeat(200));
    await writePreference("web", "quote", '"'.repeat(200));
    expect(preferencesFromCookies(document.cookie)).toEqual({ locale: "\u4e3b".repeat(200), quote: '"'.repeat(200) });
  });

  it("never uses the desktop bridge", async () => {
    const bridge = fakeBridge();
    await writePreference("web", "theme", "dark", { bridge });
    expect(bridge.setPref).not.toHaveBeenCalled();
  });
});

describe("writePreference in the desktop shell", () => {
  it("goes through the bridge, never document.cookie", async () => {
    const bridge = fakeBridge();
    const { doc, written } = cookieRecorder();
    await writePreference("desktop", "theme", "dark", { bridge, doc });
    await writePreference("desktop", "theme", null, { bridge, doc });
    expect(bridge.setPref).toHaveBeenCalledWith("theme", "dark");
    expect(bridge.removePref).toHaveBeenCalledWith("theme");
    expect(written).toEqual([]);
  });

  it("throws the bridge's rejection, or when there is no bridge", async () => {
    await expect(writePreference("desktop", "rejected", 1, { bridge: fakeBridge() })).rejects.toMatchObject({
      reason: "too-large",
    });
    await expect(writePreference("desktop", "theme", "dark", { bridge: undefined })).rejects.toMatchObject({
      reason: "bridge-unavailable",
    });
  });
});

function Page() {
  const data = useLoaderData<{ prefs: unknown; loads: number }>();
  const setPreference = useSetPreference();
  return (
    <>
      <p data-testid="prefs">{JSON.stringify(data)}</p>
      <button type="button" onClick={() => void setPreference("theme", "dark")}>
        dark
      </button>
    </>
  );
}

/** A route whose loader reports the preferences the shell's store holds, as the host would give them. */
function renderApp(shell: Shell, read: () => unknown) {
  let loads = 0;
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <AppRoot shell={shell}>
          <Page />
        </AppRoot>
      ),
      loader: () => ({ prefs: read(), loads: ++loads }),
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
}

describe("useSetPreference", () => {
  it("writes the cookie in the web shell and revalidates", async () => {
    renderApp({ kind: "web" }, () => preferencesFromCookies(document.cookie));
    expect(await screen.findByText('{"prefs":{},"loads":1}')).toBeInTheDocument();
    await act(async () => screen.getByRole("button").click());
    expect(await screen.findByText('{"prefs":{"theme":"dark"},"loads":2}')).toBeInTheDocument();
  });

  it("writes through the bridge in the desktop shell and revalidates", async () => {
    const stored: Record<string, unknown> = {};
    window.desktop = fakeBridge(stored);
    renderApp(desktopShell, () => ({ ...stored }));
    expect(await screen.findByText('{"prefs":{},"loads":1}')).toBeInTheDocument();
    await act(async () => screen.getByRole("button").click());
    expect(await screen.findByText('{"prefs":{"theme":"dark"},"loads":2}')).toBeInTheDocument();
    expect(document.cookie).toBe("");
  });
});
