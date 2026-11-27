import { visualRecordKernel, type VisualRecord } from "@repo/shared";
import { render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

import { AppRoot } from "~/providers/app-root";

import { visualBootstrapConfig } from "./bootstrap";
import { useVisualManager, useVisualState } from "./hooks";
import type { createVisualManager } from "./manager";
import { VisualManagerProvider } from "./provider";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("keeps one committed manager through registry rerenders and cleans up StrictMode subscriptions", () => {
  const queries = ["(prefers-color-scheme: dark)", "(prefers-reduced-motion: reduce)"];
  const active = new Map(queries.map((query) => [query, new Set<() => void>()]));
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    addEventListener: (_: string, callback: () => void) => active.get(query)!.add(callback),
    removeEventListener: (_: string, callback: () => void) => active.get(query)!.delete(callback),
  }));
  const counts = () => queries.map((query) => active.get(query)!.size);
  const seen: ReturnType<typeof createVisualManager>[] = [];
  function Consumer() {
    const manager = useVisualManager();
    const state = useVisualState();
    seen.push(manager);
    return <output>{visualRecordKernel.effective(state).colorScheme}</output>;
  }
  const tree = (
    <StrictMode>
      <AppRoot>
        <Consumer />
      </AppRoot>
    </StrictMode>
  );
  const { rerender, unmount } = render(tree);
  const manager = seen.at(-1);
  expect(counts()).toEqual([1, 1]);
  const renders = seen.length;
  rerender(
    <StrictMode>
      <AppRoot>
        <Consumer />
      </AppRoot>
    </StrictMode>,
  );
  expect(seen.length).toBeGreaterThan(renders);
  expect(seen.at(-1)).toBe(manager);
  expect(counts()).toEqual([1, 1]);
  expect(screen.getByText("auto")).toBeTruthy();
  unmount();
  expect(counts()).toEqual([0, 0]);
});

it("uses only the prepaint handoff and request snapshot during React render", () => {
  const local = vi.spyOn(window, "localStorage", "get");
  const cookie = vi.spyOn(document, "cookie", "get");
  const connect = vi.fn<() => undefined>();
  const read = vi.fn<() => undefined>();
  const initialRecord: VisualRecord = { version: 1, stamp: { t: 1, id: "a" }, preferences: { direction: "ltr" } };
  window.frameworkVisualBootstrap = {
    storageKey: visualBootstrapConfig.storageKey,
    record: { ...initialRecord, preferences: { direction: "rtl" } },
    state: {
      preferences: { direction: "rtl" },
      resolved: { direction: "rtl", colorScheme: "light", reducedMotion: false },
    },
  };
  try {
    const markup = renderToString(
      <VisualManagerProvider initialRecord={initialRecord} nativeSource={{ connect, prepaint: read }}>
        <SnapshotProbe />
      </VisualManagerProvider>,
    );
    expect(markup).toContain("ltr");
    for (const boundary of [local, cookie, connect, read]) expect(boundary).not.toHaveBeenCalled();
  } finally {
    local.mockRestore();
    cookie.mockRestore();
    delete window.frameworkVisualBootstrap;
  }
});

function SnapshotProbe() {
  const manager = useVisualManager();
  expect(manager.getServerSnapshot().preferences).toEqual({ direction: "ltr" });
  expect(manager.getSnapshot().preferences).toEqual({ direction: "rtl" });
  expect(manager.getServerStatus().initialized).toBe(false);
  return <span>{useVisualState().preferences.direction}</span>;
}
