// @vitest-environment jsdom
import { type DesktopBridge, PREFERENCE_COOKIE_PREFIX, type PreferenceValue, type Shell } from "@repo/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import {
  createRoutesStub,
  type LoaderFunctionArgs,
  Outlet,
  useLoaderData,
  useNavigate,
  useNavigation,
} from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getPreference, useSetPreference } from "~/platform/electron/preferences";
import { AppRoot } from "~/providers/app-root";
import * as rootRoute from "~/root";

import { createLoadContext } from "./app";

const KEY = "sidebarWidth";
const desktopShell: Shell = { kind: "desktop", platform: "darwin", osVersion: "26" };

afterEach(() => {
  delete window.desktop;
  document.cookie = `${PREFERENCE_COOKIE_PREFIX}${KEY}=; Path=/; Max-Age=0`;
  vi.restoreAllMocks();
});

function renderPreferences(shell: Shell) {
  const stored: Record<string, PreferenceValue> = {};
  const write = vi.fn<DesktopBridge["setPref"]>(async (key, value) => {
    stored[key] = value;
    return { status: "applied" };
  });
  if (shell.kind === "desktop") {
    const bridge: DesktopBridge = {
      platform: shell.platform,
      version: "1",
      bootstrap: { protocolVersion: 1, shell, mode: "system-decorated" },
      subscribeWindowState: () => () => {},
      updateOverlayAppearance: async () => ({ status: "unsupported", reason: "system-decorated" }),
      setPref: write,
      removePref: async (key) => {
        delete stored[key];
        return { status: "applied" };
      },
    };
    window.desktop = bridge;
  }
  // A new request/context for every load, as in the host. Only the desktop persistence boundary
  // is fake; the preference helpers, host parsing, root loader and Router revalidation are real.
  function requestScope(request: Request) {
    const headers = new Headers(request.headers);
    if (shell.kind === "web") headers.set("cookie", document.cookie);
    const incoming = new Request(request, { headers });
    return {
      request: incoming,
      context: createLoadContext(incoming, {
        shell,
        desktop:
          shell.kind === "desktop"
            ? { titlebar: "native", chromeMode: "system-decorated", fullscreen: false, prefs: { ...stored } }
            : undefined,
      }),
    };
  }
  const loadRoot = vi.fn<
    (args: LoaderFunctionArgs) => ReturnType<typeof rootRoute.loader> & { preference: PreferenceValue }
  >(({ request, params }) => {
    const scope = requestScope(request);
    return {
      ...rootRoute.loader({ ...scope, params, url: new URL(request.url), pattern: "/" }),
      preference: getPreference(scope.context, KEY) ?? "unset",
    };
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loadNext = vi.fn<(args: LoaderFunctionArgs) => Promise<{ preference: PreferenceValue }>>(
    async ({ request }) => {
      const preference = getPreference(requestScope(request).context, KEY) ?? "unset";
      await gate;
      return { preference };
    },
  );
  function Controls() {
    const data = useLoaderData<ReturnType<typeof loadRoot>>();
    const save = useSetPreference();
    const navigate = useNavigate();
    const navigation = useNavigation();
    const [result, setResult] = useState("idle");
    async function change(value: number | null) {
      setResult("saving");
      try {
        await save(KEY, value);
        setResult("saved");
      } catch {
        setResult("failed");
      }
    }
    return (
      <>
        <p data-testid="root-preference">{data.preference}</p>
        <p data-testid="navigation">{navigation.state}</p>
        <p data-testid="save-result">{result}</p>
        <button type="button" onClick={() => void change(320)}>
          Save width
        </button>
        <button type="button" onClick={() => void change(null)}>
          Remove width
        </button>
        <button type="button" onClick={() => void navigate("/next")}>
          Next page
        </button>
        <Outlet />
      </>
    );
  }
  const Stub = createRoutesStub([
    {
      // Retain any root revalidation policy: adding an unsafe one must fail this contract test.
      ...rootRoute,
      id: "root",
      path: "/",
      loader: loadRoot,
      HydrateFallback: () => null,
      Component: () => (
        <AppRoot shell={shell}>
          <Controls />
        </AppRoot>
      ),
      children: [
        { index: true, Component: () => <p>First page</p> },
        {
          path: "next",
          loader: loadNext,
          Component: () => {
            const data = useLoaderData<Awaited<ReturnType<typeof loadNext>>>();
            return <p data-testid="next-preference">{data.preference}</p>;
          },
        },
      ],
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
  return { loadRoot, loadNext, write, release };
}

describe.each([{ kind: "web" } as const, desktopShell])("$kind preference revalidation", (shell) => {
  it("refreshes the loader after saving and removing a preference", async () => {
    renderPreferences(shell);
    await screen.findByText("First page");
    expect(screen.getByTestId("root-preference")).toHaveTextContent("unset");
    await act(async () => screen.getByRole("button", { name: "Save width" }).click());
    await waitFor(() => expect(screen.getByTestId("save-result")).toHaveTextContent("saved"));
    expect(screen.getByTestId("root-preference")).toHaveTextContent("320");
    await act(async () => screen.getByRole("button", { name: "Remove width" }).click());
    await waitFor(() => expect(screen.getByTestId("root-preference")).toHaveTextContent("unset"));
  });

  it("refreshes the root and destination when a preference changes during navigation", async () => {
    const view = renderPreferences(shell);
    try {
      await screen.findByText("First page");
      await act(async () => screen.getByRole("button", { name: "Next page" }).click());
      await waitFor(() => expect(view.loadNext).toHaveBeenCalledOnce());
      expect(screen.getByTestId("navigation")).toHaveTextContent("loading");
      await act(async () => screen.getByRole("button", { name: "Save width" }).click());
      // An explicit revalidation restarts the pending navigation while current and next URLs differ.
      await waitFor(() => expect(view.loadNext).toHaveBeenCalledTimes(2));
      expect(screen.getByTestId("save-result")).toHaveTextContent("saving");
      await act(async () => view.release());
      await waitFor(() => expect(screen.getByTestId("save-result")).toHaveTextContent("saved"));
      expect(screen.getByTestId("root-preference")).toHaveTextContent("320");
      expect(screen.getByTestId("next-preference")).toHaveTextContent("320");
      expect(screen.getByTestId("navigation")).toHaveTextContent("idle");
    } finally {
      view.release();
    }
  });
});

it("keeps loader data after a rejected desktop write and refreshes it on retry", async () => {
  const view = renderPreferences(desktopShell);
  view.write.mockResolvedValueOnce({ status: "rejected", reason: "too-large" });
  await screen.findByText("First page");
  await act(async () => screen.getByRole("button", { name: "Save width" }).click());
  await waitFor(() => expect(screen.getByTestId("save-result")).toHaveTextContent("failed"));
  expect(view.loadRoot).toHaveBeenCalledOnce();
  expect(screen.getByTestId("root-preference")).toHaveTextContent("unset");
  await act(async () => screen.getByRole("button", { name: "Save width" }).click());
  await waitFor(() => expect(screen.getByTestId("save-result")).toHaveTextContent("saved"));
  expect(screen.getByTestId("root-preference")).toHaveTextContent("320");
});
