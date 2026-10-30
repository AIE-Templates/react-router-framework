import { act, fireEvent, render } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { ContentScrollRestoration } from "./content-scroll-restoration";

const scroll = (element: HTMLElement, top: number, left = 0) => {
  element.scrollTop = top;
  element.scrollLeft = left;
  fireEvent.scroll(element);
};

function fixture() {
  const router = createMemoryRouter(
    [
      {
        Component: () => (
          <ContentScrollRestoration>
            <Outlet />
          </ContentScrollRestoration>
        ),
        children: [
          {
            path: "/:page",
            Component: () => (
              <div data-scroll-restoration-id="module:workspace">
                <h1 id="target">Page</h1>
              </div>
            ),
          },
        ],
      },
    ],
    { initialEntries: ["/one"] },
  );
  const { container, unmount } = render(<RouterProvider router={router} />);
  const root = container.querySelector<HTMLElement>(".root-content")!;
  const pane = () => container.querySelector<HTMLElement>('[data-scroll-restoration-id="module:workspace"]')!;
  return { router, root, pane, unmount };
}

describe("container scroll restoration", () => {
  it("resets new routes and restores both root and module positions on back and forward", async () => {
    const { router, root, pane } = fixture();
    scroll(root, 420, 8);
    scroll(pane(), 230, 12);
    await act(() => router.navigate("/two"));
    expect(root.scrollTop).toBe(0);
    expect(pane().scrollTop).toBe(0);
    scroll(root, 70);
    scroll(pane(), 90);
    await act(() => router.navigate(-1));
    expect([root.scrollLeft, root.scrollTop]).toEqual([8, 420]);
    expect([pane().scrollLeft, pane().scrollTop]).toEqual([12, 230]);
    await act(() => router.navigate(1));
    expect(root.scrollTop).toBe(70);
    expect(pane().scrollTop).toBe(90);
  });

  it("keeps separate entries for the same URL and handles replace navigation", async () => {
    const { router, root } = fixture();
    scroll(root, 140);
    await act(() => router.navigate("/one"));
    expect(root.scrollTop).toBe(0);
    scroll(root, 250);
    await act(() => router.navigate("/two", { replace: true }));
    expect(root.scrollTop).toBe(0);
    await act(() => router.navigate(-1));
    expect(root.scrollTop).toBe(140);
  });

  it("honors fragments on new navigation and saved positions on history traversal", async () => {
    const scrollIntoView = vi.fn<() => void>();
    const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      const { router, root } = fixture();
      scroll(root, 120);
      await act(() => router.navigate("/two#target"));
      expect(scrollIntoView).toHaveBeenCalledOnce();
      await act(() => router.navigate(-1));
      expect(root.scrollTop).toBe(120);
      expect(scrollIntoView).toHaveBeenCalledOnce();
      await act(() => router.navigate("/two#%bad"));
      expect(root.scrollTop).toBe(0);
    } finally {
      if (previous) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", previous);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });
});
