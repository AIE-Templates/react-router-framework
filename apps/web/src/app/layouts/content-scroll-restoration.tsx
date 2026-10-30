import { useLayoutEffect, useRef, type ReactNode } from "react";
import { NavigationType, useLocation, useNavigationType } from "react-router";

type Positions = Map<string, [number, number]>;
const selector = "[data-scroll-restoration-id]";

/** Container scrolling complements React Router's window ScrollRestoration.
 * Positions belong to history entries in this document, not to route paths.
 */
export function ContentScrollRestoration({ children }: { children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  const history = useRef(new Map<string, Positions>());
  const location = useLocation();
  const navigationType = useNavigationType();

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return undefined;
    const positions = history.current;
    const saved = navigationType === NavigationType.Pop ? positions.get(location.key) : undefined;
    const current: Positions = new Map(saved);
    positions.set(location.key, current);
    // Bound memory in long-lived desktop sessions.
    if (positions.size > 100) positions.delete(positions.keys().next().value!);
    const elements = [root, ...root.querySelectorAll<HTMLElement>(selector)];
    for (const element of elements) {
      const [left, top] = saved?.get(element.dataset.scrollRestorationId!) ?? [0, 0];
      element.scrollLeft = left;
      element.scrollTop = top;
    }
    if (!saved && location.hash) {
      try {
        const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
        if (target && root.contains(target)) target.scrollIntoView();
      } catch {
        // A malformed URL fragment must not break navigation.
      }
    }
    const record = (event: Event) => {
      const element = event.target;
      if (element instanceof HTMLElement && element.matches(selector)) {
        current.set(element.dataset.scrollRestorationId!, [element.scrollLeft, element.scrollTop]);
      }
    };
    // Scroll does not bubble; capture records nested module panes as well as the root.
    root.addEventListener("scroll", record, true);
    return () => root.removeEventListener("scroll", record, true);
  }, [location.key, location.hash, navigationType]);

  return (
    <div ref={container} className="root-content" data-scroll-restoration-id="root">
      {children}
    </div>
  );
}
