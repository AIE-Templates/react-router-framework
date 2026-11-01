import { render, type RenderOptions } from "@testing-library/react";
import type { ComponentProps, PropsWithChildren, ReactElement } from "react";

import { AppRoot } from "~/providers/app-root";
import { AppUiProvider } from "~/providers/app-ui-provider";

type Options = Omit<RenderOptions, "wrapper"> & {
  appRoot?: Omit<ComponentProps<typeof AppRoot>, "children">;
};

/** Ordinary UI tests share the real application providers; specialized lifecycle tests need not. */
export function renderWithProviders(ui: ReactElement, { appRoot, ...options }: Options = {}) {
  function Providers({ children }: PropsWithChildren) {
    return (
      <AppRoot {...appRoot}>
        <AppUiProvider>{children}</AppUiProvider>
      </AppRoot>
    );
  }
  return render(ui, { ...options, wrapper: Providers });
}
