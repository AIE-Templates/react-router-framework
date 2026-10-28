import { fireEvent, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { describe, expect, it, vi } from "vitest";

import { AppRoot } from "../../providers/app-root";
import { getInteractiveProps } from "../../providers/environment";
import { BasicShell, NavigationShell } from "../app-shell/app-shell";
import { ModuleLayout } from "./module-layout";

const layout = (headerMode: "fused" | "standalone") => (
  <AppRoot>
    <BasicShell headerMode={headerMode} title="App">
      <ModuleLayout
        moduleId="one"
        title="One"
        sidebar="Navigation"
        auxiliary="Tools"
        defaultSidebarOpen
        defaultAuxiliaryOpen
      >
        Body
      </ModuleLayout>
    </BasicShell>
  </AppRoot>
);

describe("layout composition", () => {
  it("does not reserve a missing panel column even when its requested state is open", () => {
    const { container } = render(
      <AppRoot>
        <BasicShell>
          <ModuleLayout moduleId="one" title="One" defaultSidebarOpen defaultAuxiliaryOpen>
            Body
          </ModuleLayout>
        </BasicShell>
      </AppRoot>,
    );
    expect(container.querySelector(".module-layout")).toHaveAttribute("data-sidebar-open", "false");
    expect(container.querySelector(".module-layout")).toHaveAttribute("data-auxiliary-open", "false");
    expect(container.querySelector(".module-sidebar,.module-auxiliary")).toBeNull();
  });

  it("opens and closes a module panel, restoring focus while preserving workspace state", () => {
    render(
      <AppRoot>
        <BasicShell>
          <ModuleLayout moduleId="example" title="Example" sidebar={<p>Sidebar contents</p>} auxiliary={<p>Tools</p>}>
            <input aria-label="Draft" />
          </ModuleLayout>
        </BasicShell>
      </AppRoot>,
    );
    const draft = screen.getByRole("textbox", { name: "Draft" });
    fireEvent.change(draft, { target: { value: "A retained draft" } });
    const toggle = screen.getByRole("button", { name: "Sidebar" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByRole("complementary", { name: "Module sidebar" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Close sidebar" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("complementary", { name: "Module sidebar" }), { key: "Escape" });
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(draft).toHaveValue("A retained draft");
  });

  it("keeps controlled panels authoritative and application navigation independent", () => {
    const onSidebarOpenChange = vi.fn<(open: boolean) => void>();
    render(
      <AppRoot>
        <NavigationShell navigation={<a href="/">Module one</a>}>
          <ModuleLayout
            moduleId="one"
            title="One"
            sidebar={<p>Side</p>}
            sidebarOpen={false}
            onSidebarOpenChange={onSidebarOpenChange}
          >
            Body
          </ModuleLayout>
        </NavigationShell>
      </AppRoot>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sidebar" }));
    expect(onSidebarOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: "Sidebar" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Modules" }));
    expect(screen.getByRole("button", { name: "Modules" })).toHaveAttribute("aria-expanded", "true");
    expect(onSidebarOpenChange).toHaveBeenCalledOnce();
  });

  it("only marks a directly composed module header as complete and excludes portalled controls from drag", () => {
    const { container } = render(
      <AppRoot>
        <BasicShell>
          <ModuleLayout moduleId="one" title="One">
            Body
          </ModuleLayout>
        </BasicShell>
        {createPortal(<button {...getInteractiveProps()}>Portal action</button>, document.body)}
      </AppRoot>,
    );
    expect(
      container.querySelector(
        ".app-shell > .shell-body > .module-layout[data-chrome-complete] > .module-columns > .module-workspace > .module-header[data-window-drag]",
      ),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Portal action" })).toHaveAttribute("data-window-interactive");
  });

  it("removes all module drag bindings when switching from fused to standalone", () => {
    const { container, rerender } = render(layout("fused"));
    expect(container.querySelectorAll(".module-header[data-window-drag]")).toHaveLength(3);
    rerender(layout("standalone"));
    expect(container.querySelectorAll(".module-header[data-window-drag]")).toHaveLength(0);
    expect(container.querySelector(".shell-titlebar-content")).toHaveAttribute("data-window-drag");
    rerender(layout("fused"));
    expect(container.querySelectorAll(".module-header[data-window-drag]")).toHaveLength(3);
  });

  it("retains fallback ownership for arbitrary content and standalone modules", () => {
    const { container, rerender } = render(
      <AppRoot>
        <BasicShell>
          <header>Arbitrary header</header>
        </BasicShell>
      </AppRoot>,
    );
    expect(container.querySelector("[data-chrome-complete]")).toBeNull();
    rerender(
      <AppRoot>
        <BasicShell headerMode="standalone" title="App">
          <ModuleLayout moduleId="one" title="One">
            Body
          </ModuleLayout>
        </BasicShell>
      </AppRoot>,
    );
    expect(container.querySelector(".shell-titlebar")).not.toBeNull();
    expect(container.querySelector("[data-chrome-complete]")).toBeNull();
  });
});
