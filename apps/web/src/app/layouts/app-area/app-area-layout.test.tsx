import { fireEvent, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { describe, expect, it, vi } from "vitest";

import { BasicShell, NavigationShell } from "~/layouts/app-shell/app-shell";
import { getInteractiveProps } from "~/platform/chrome-adapter/dom-props";
import { AppRoot } from "~/providers/app-root";

import { AppAreaLayout } from "./app-area-layout";

const layout = (headerMode: "fused" | "standalone") => (
  <AppRoot>
    <BasicShell headerMode={headerMode} title="App">
      <AppAreaLayout
        areaId="one"
        title="One"
        sidebar="Navigation"
        auxiliary="Tools"
        defaultSidebarOpen
        defaultAuxiliaryOpen
      >
        Body
      </AppAreaLayout>
    </BasicShell>
  </AppRoot>
);

describe("layout composition", () => {
  it("lets the page own one main landmark while nested and sibling layouts remain containers", () => {
    render(
      <AppRoot>
        <AppAreaLayout areaId="page" title="Page" contentAs="main">
          <AppAreaLayout areaId="nested" title="Nested">
            Nested content
          </AppAreaLayout>
        </AppAreaLayout>
        <AppAreaLayout areaId="sibling" title="Sibling">
          Sibling content
        </AppAreaLayout>
      </AppRoot>,
    );
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("main").closest('section[aria-label], [role="region"]')).toBeNull();
    expect(screen.getByRole("main")).toHaveTextContent("Nested content");
    expect(screen.getByRole("main")).not.toHaveTextContent("Sibling content");
  });

  it("does not reserve a missing panel column even when its requested state is open", () => {
    const { container } = render(
      <AppRoot>
        <BasicShell>
          <AppAreaLayout areaId="one" title="One" defaultSidebarOpen defaultAuxiliaryOpen>
            Body
          </AppAreaLayout>
        </BasicShell>
      </AppRoot>,
    );
    expect(container.querySelector(".app-area-layout")).toHaveAttribute("data-sidebar-open", "false");
    expect(container.querySelector(".app-area-layout")).toHaveAttribute("data-auxiliary-open", "false");
    expect(container.querySelector(".app-area-sidebar,.app-area-auxiliary")).toBeNull();
  });

  it("opens and closes an area panel, restoring focus while preserving workspace state", () => {
    render(
      <AppRoot>
        <BasicShell>
          <AppAreaLayout areaId="example" title="Example" sidebar={<p>Sidebar contents</p>} auxiliary={<p>Tools</p>}>
            <input aria-label="Draft" />
          </AppAreaLayout>
        </BasicShell>
      </AppRoot>,
    );
    const draft = screen.getByRole("textbox", { name: "Draft" });
    fireEvent.change(draft, { target: { value: "A retained draft" } });
    const toggle = screen.getByRole("button", { name: "Sidebar" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByRole("complementary", { name: "Area sidebar" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Close sidebar" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("complementary", { name: "Area sidebar" }), { key: "Escape" });
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(draft).toHaveValue("A retained draft");
  });

  it("leaves Escape to the control that handled it", () => {
    render(
      <AppRoot>
        <BasicShell>
          <AppAreaLayout
            areaId="editor"
            title="Editor"
            defaultSidebarOpen
            sidebar={<textarea aria-label="Filter" onKeyDown={(event) => event.preventDefault()} />}
          >
            Body
          </AppAreaLayout>
        </BasicShell>
      </AppRoot>,
    );
    const field = screen.getByRole("textbox", { name: "Filter" });
    field.focus();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Sidebar" })).toHaveAttribute("aria-expanded", "true");
    expect(field).toHaveFocus();
  });

  it("uses navigationLabel for the landmark and keeps the drawer trigger name", () => {
    render(
      <AppRoot>
        <NavigationShell navigation={<a href="/">Home</a>} navigationLabel="Library">
          Content
        </NavigationShell>
      </AppRoot>,
    );
    expect(screen.getByRole("navigation", { name: "Library" })).toHaveAttribute(
      "id",
      screen.getByRole("button", { name: "Switch area" }).getAttribute("aria-controls"),
    );
  });

  it("keeps controlled panels authoritative and application navigation independent", () => {
    const onSidebarOpenChange = vi.fn<(open: boolean) => void>();
    render(
      <AppRoot>
        <NavigationShell navigation={<a href="/">Area one</a>}>
          <AppAreaLayout
            areaId="one"
            title="One"
            sidebar={<p>Side</p>}
            sidebarOpen={false}
            onSidebarOpenChange={onSidebarOpenChange}
          >
            Body
          </AppAreaLayout>
        </NavigationShell>
      </AppRoot>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sidebar" }));
    expect(onSidebarOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: "Sidebar" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("navigation", { name: "App areas" })).toHaveAttribute(
      "id",
      screen.getByRole("button", { name: "Switch area" }).getAttribute("aria-controls"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Switch area" }));
    expect(screen.getByRole("button", { name: "Switch area" })).toHaveAttribute("aria-expanded", "true");
    expect(onSidebarOpenChange).toHaveBeenCalledOnce();
  });

  it("renders the fused header handoff path and excludes portalled controls from drag", () => {
    const { container } = render(
      <AppRoot>
        <BasicShell>
          <AppAreaLayout areaId="one" title="One">
            Body
          </AppAreaLayout>
        </BasicShell>
        {createPortal(<button {...getInteractiveProps()}>Portal action</button>, document.body)}
      </AppRoot>,
    );
    expect(
      container.querySelector(
        ".app-shell > .shell-body > [data-window-layout] > [data-window-columns] > [data-window-column] > [data-window-header=primary][data-window-drag]",
      ),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Portal action" })).toHaveAttribute("data-window-interactive");
  });

  it("removes all area drag bindings when switching from fused to standalone", () => {
    const { container, rerender } = render(layout("fused"));
    expect(container.querySelectorAll(".app-area-header[data-window-drag]")).toHaveLength(3);
    rerender(layout("standalone"));
    expect(container.querySelectorAll(".app-area-header[data-window-drag]")).toHaveLength(0);
    expect(container.querySelector(".shell-titlebar-content")).toHaveAttribute("data-window-drag");
    rerender(layout("fused"));
    expect(container.querySelectorAll(".app-area-header[data-window-drag]")).toHaveLength(3);
  });

  it("retains fallback ownership for arbitrary content and standalone area layouts", () => {
    const { container, rerender } = render(
      <AppRoot>
        <BasicShell>
          <header>Arbitrary header</header>
        </BasicShell>
      </AppRoot>,
    );
    expect(container.querySelector("[data-window-header][data-window-drag]")).toBeNull();
    rerender(
      <AppRoot>
        <BasicShell headerMode="standalone" title="App">
          <AppAreaLayout areaId="one" title="One">
            Body
          </AppAreaLayout>
        </BasicShell>
      </AppRoot>,
    );
    expect(container.querySelector(".shell-titlebar")).not.toBeNull();
    expect(container.querySelector("[data-window-header][data-window-drag]")).toBeNull();
  });
});
