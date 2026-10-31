import { act, render, screen } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { STORAGE_KEYS } from "../../../config/storage";
import { visualCookie } from "../../../config/visual-cookie";
import { AppRoot } from "../../../providers/app-root";
import { useVisualManager } from "../hooks";
import type { VisualManager } from "../manager";
import { DEFAULT_VISUAL_PREFERENCES } from "../types";
import { readVisualCookie } from "./cookie";
import { useVisualCookieStatus } from "./cookie-context";

let manager: VisualManager;
function Consumer() {
  const current = useVisualManager();
  useEffect(() => {
    manager = current;
  }, [current]);
  return <output>{useVisualCookieStatus().status}</output>;
}
beforeEach(() => {
  visualCookie.enabled = true;
});
afterEach(() => {
  visualCookie.enabled = false;
  vi.restoreAllMocks();
  localStorage.clear();
  document.cookie = `${visualCookie.name}=; Max-Age=0; Path=/`;
});
it("seeds once through StrictMode, mirrors external deletion and never restores the stale seed", () => {
  const seed = { colorScheme: "dark", direction: "rtl", reducedMotion: "reduce" } as const;
  render(
    <StrictMode>
      <AppRoot managersInitialState={{ visual: seed }}>
        <Consumer />
      </AppRoot>
    </StrictMode>,
  );
  expect(manager.getSnapshot().preferences).toEqual(seed);
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.visualPreferences)!)).toMatchObject({ preferences: seed });
  expect(readVisualCookie(document.cookie)).toMatchObject({ preferences: seed });
  expect(screen.getByRole("status")).toHaveTextContent("synced");
  act(() => {
    localStorage.removeItem(STORAGE_KEYS.visualPreferences);
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEYS.visualPreferences }));
  });
  expect(localStorage.getItem(STORAGE_KEYS.visualPreferences)).toBeNull();
  expect(readVisualCookie(document.cookie)).toMatchObject({ preferences: DEFAULT_VISUAL_PREFERENCES });
});
it("mirrors failed local saves without reverting session state and protects future cookie versions until reset", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  render(
    <AppRoot>
      <Consumer />
    </AppRoot>,
  );
  act(() => manager.actions.setColorSchemePreference("dark"));
  expect(manager.getStatus().persistence).toBe("failed");
  expect(manager.getSnapshot().preferences.colorScheme).toBe("dark");
  expect(readVisualCookie(document.cookie)).toMatchObject({ preferences: { colorScheme: "dark" } });
  document.cookie = `${visualCookie.name}=${encodeURIComponent('{"version":2}')}; Path=/`;
  act(() => manager.actions.setDirection("rtl"));
  expect(screen.getByRole("status")).toHaveTextContent("unsupported-version");
  act(() => manager.actions.resetVisualPreferences());
  expect(screen.getByRole("status")).toHaveTextContent("synced");
  expect(readVisualCookie(document.cookie)).toMatchObject({ preferences: DEFAULT_VISUAL_PREFERENCES });
});
it("does not mirror desktop preferences even when Web cookie support is enabled", () => {
  render(
    <AppRoot shell={{ kind: "desktop", platform: "darwin", osVersion: "test" }}>
      <Consumer />
    </AppRoot>,
  );
  act(() => manager.actions.setColorSchemePreference("dark"));
  expect(screen.getByRole("status")).toHaveTextContent("disabled");
  expect(readVisualCookie(document.cookie).kind).toBe("missing");
});
