import { useContext, useLayoutEffect, useRef, type ComponentPropsWithoutRef, type ReactNode } from "react";

import { ShellChromeContext } from "./chrome-context";

/** One grid defines the tracks for both the window headers and their scrolling content. */
export function WindowLayout({
  columns,
  children,
  gridClassName,
  ...rootProps
}: ComponentPropsWithoutRef<"section"> & { columns?: string; gridClassName?: string }) {
  const grid = useRef<HTMLDivElement>(null);
  const fused = useContext(ShellChromeContext);
  useLayoutEffect(() => {
    const element = grid.current;
    if (!element || !fused || typeof ResizeObserver === "undefined") return undefined;
    // Only panel bounds are measured. Native button geometry stays in CSS env() so
    // fullscreen, zoom and host changes never depend on a renderer IPC round trip.
    // ResizeObserver covers resizing. A column can also slide between equal tracks
    // without resizing. Observe its current horizontal strip to detect that move.
    const strips = new Map<Element, IntersectionObserver>();
    const measure = () => {
      for (const column of element.children) {
        const header = column.firstElementChild;
        if (!(header instanceof HTMLElement)) continue;
        const { left, right, width } = column.getBoundingClientRect();
        const leftGap = width ? left + "px" : "";
        const rightGap = width ? window.innerWidth - right + "px" : "";
        if (
          header.style.getPropertyValue("--app-window-column-left") === leftGap &&
          header.style.getPropertyValue("--app-window-column-right") === rightGap
        )
          continue;
        header.style.setProperty("--app-window-column-left", leftGap);
        header.style.setProperty("--app-window-column-right", rightGap);
        strips.get(column)?.disconnect();
        strips.delete(column);
        if (width && typeof IntersectionObserver !== "undefined") {
          const observer = new IntersectionObserver(measure, {
            rootMargin: `100% ${Math.ceil(right - window.innerWidth)}px 100% ${-Math.floor(left)}px`,
            threshold: 1,
          });
          observer.observe(column);
          strips.set(column, observer);
        }
      }
    };
    const sizes = new ResizeObserver(measure);
    const positions = new MutationObserver(measure);
    const bind = () => {
      sizes.disconnect();
      positions.disconnect();
      for (const [column, observer] of strips) {
        if (column.parentElement !== element) {
          observer.disconnect();
          strips.delete(column);
        }
      }
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        positions.observe(ancestor, { attributes: true });
      }
      sizes.observe(element);
      for (const column of element.children) {
        sizes.observe(column);
        positions.observe(column, { attributes: true });
      }
      measure();
    };
    bind();
    const mutations = new MutationObserver(bind);
    mutations.observe(element, { childList: true });
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      sizes.disconnect();
      mutations.disconnect();
      positions.disconnect();
      for (const observer of strips.values()) observer.disconnect();
      for (const column of element.children) {
        const header = column.firstElementChild;
        if (!(header instanceof HTMLElement)) continue;
        header.style.removeProperty("--app-window-column-left");
        header.style.removeProperty("--app-window-column-right");
      }
    };
  }, [fused]);
  return (
    <section {...rootProps} data-window-layout="">
      <div ref={grid} data-window-columns="" className={gridClassName} style={{ gridTemplateColumns: columns }}>
        {children}
      </div>
    </section>
  );
}

/** The primary header hands off the root fallback and anchors the area switcher. */
export function WindowColumn({
  primary = false,
  inWindowBand = true,
  header,
  headerClassName,
  children,
  as: Element = "section",
  ...props
}: ComponentPropsWithoutRef<"section"> & {
  primary?: boolean;
  inWindowBand?: boolean;
  header: ReactNode;
  headerClassName?: string;
  as?: "section" | "aside";
}) {
  const fused = useContext(ShellChromeContext);
  return (
    <Element {...props} data-window-column="">
      <header
        className={headerClassName}
        data-window-header={primary && inWindowBand ? "primary" : "secondary"}
        data-window-drag={fused && inWindowBand ? "" : undefined}
      >
        {header}
      </header>
      <div data-window-column-body="">
        <ShellChromeContext.Provider value={false}>{children}</ShellChromeContext.Provider>
      </div>
    </Element>
  );
}
