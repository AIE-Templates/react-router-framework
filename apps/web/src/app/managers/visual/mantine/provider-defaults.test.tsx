import { useMantineColorScheme } from "@mantine/core";
import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { visualCookie } from "~/config/visual-cookie";
import { useVisualManager } from "~/managers/visual/hooks";
import { VisualManagerProvider } from "~/managers/visual/provider";

import { VisualMantineProvider } from "./provider";

// A concrete product default makes a hardcoded "auto" observable.
vi.mock(import("@repo/shared"), async (original) => {
  const shared = await original();
  const defaults = { ...shared.VISUAL_DEFAULTS, colorScheme: "light" as const };
  return { ...shared, VISUAL_DEFAULTS: defaults, visualRecordKernel: shared.createVisualRecordKernel(defaults) };
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.cookie = visualCookie.name + "=; Path=/; Max-Age=0";
});

function Providers({ children }: PropsWithChildren) {
  return (
    <VisualManagerProvider>
      <VisualMantineProvider>{children}</VisualMantineProvider>
    </VisualManagerProvider>
  );
}
function useAppearance() {
  return { visual: useVisualManager(), mantine: useMantineColorScheme() };
}

it("mounts with effective defaults and only persists a changed Mantine preference or an explicit VisualManager choice", () => {
  const local = vi.spyOn(Storage.prototype, "setItem");
  const cookie = vi.spyOn(Document.prototype, "cookie", "set");
  const { result } = renderHook(useAppearance, { wrapper: Providers });
  expect(result.current.visual.getStatus().initialized).toBe(true);
  expect(result.current.mantine.colorScheme).toBe("light");
  act(() => result.current.mantine.setColorScheme("light"));
  expect(result.current.visual.getSnapshot().preferences).toEqual({});
  expect(local).not.toHaveBeenCalled();
  expect(cookie).not.toHaveBeenCalled();

  act(() => result.current.visual.actions.setColorSchemePreference("light"));
  expect(result.current.visual.getSnapshot().preferences).toEqual({ colorScheme: "light" });
  expect(local).toHaveBeenCalledTimes(1);
  expect(cookie).toHaveBeenCalledTimes(1);

  act(() => result.current.mantine.setColorScheme("dark"));
  act(() => result.current.mantine.setColorScheme("dark"));
  expect(result.current.visual.getSnapshot().preferences).toEqual({ colorScheme: "dark" });
  expect(local).toHaveBeenCalledTimes(2);
  expect(cookie).toHaveBeenCalledTimes(2);
});

it("clears to the configured Mantine default even when the effective preference stays the same", () => {
  const { result } = renderHook(useAppearance, { wrapper: Providers });
  act(() => result.current.visual.actions.setColorSchemePreference("light"));
  act(() => result.current.mantine.clearColorScheme());
  expect(result.current.visual.getSnapshot().preferences).toEqual({});
  expect(result.current.mantine.colorScheme).toBe("light");
  expect(document.documentElement.dataset.mantineColorScheme).toBe("light");
});
