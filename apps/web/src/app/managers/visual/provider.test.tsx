import { render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { AppRoot } from "../../providers/app-root";
import { useVisualManager, useVisualState } from "./hooks";
import type { createVisualManager } from "./manager";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("keeps one committed manager through registry rerenders and cleans up StrictMode subscriptions", () => {
  const active = new Set<() => void>();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: (_: string, callback: () => void) => active.add(callback),
    removeEventListener: (_: string, callback: () => void) => active.delete(callback),
  }));
  const seen: ReturnType<typeof createVisualManager>[] = [];
  function Consumer() {
    const manager = useVisualManager();
    const state = useVisualState();
    seen.push(manager);
    return <output>{state.preferences.colorScheme}</output>;
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
  const count = active.size;
  rerender(tree);
  expect(seen.at(-1)).toBe(manager);
  expect(active.size).toBe(count);
  expect(count).toBeGreaterThan(0);
  expect(screen.getByText("auto")).toBeTruthy();
  unmount();
  expect(active.size).toBe(0);
});
