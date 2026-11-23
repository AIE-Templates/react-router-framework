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
  const previous = useRef<ReturnType<typeof useLocation> | undefined>(undefined);
  const pendingFragment = useRef<string | undefined>(undefined);
  const location = useLocation();
  const navigationType = useNavigationType();

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return undefined;
    const positions = history.current;
    // Native fragment entries can lack a Router history key.
    const key =
      location.key === "default" ? JSON.stringify([location.pathname, location.search, location.hash]) : location.key;
    const saved = navigationType === NavigationType.Pop ? positions.get(key) : undefined;
    const retryFragment = pendingFragment.current === key;
    pendingFragment.current = undefined;
    const keepPanes =
      previous.current?.pathname === location.pathname &&
      previous.current.search === location.search &&
      previous.current.hash !== location.hash &&
      !saved;
    previous.current = location;
    const current: Positions = new Map(saved);
    positions.set(key, current);
    // Bound memory in long-lived desktop sessions.
    if (positions.size > 100) positions.delete(positions.keys().next().value!);
    const elements = [root, ...root.querySelectorAll<HTMLElement>(selector)];
    for (const element of elements) {
      const id = element.dataset.scrollRestorationId!;
      if (keepPanes) {
        current.set(id, [element.scrollLeft, element.scrollTop]);
        continue;
      }
      const [left, top] = saved?.get(id) ?? [0, 0];
      element.scrollLeft = left;
      element.scrollTop = top;
    }
    let observer: MutationObserver | undefined;
    if ((!saved || retryFragment) && location.hash) {
      try {
        const id = decodeURIComponent(location.hash.slice(1));
        const scrollToTarget = () => {
          const target = document.getElementById(id);
          if (!target || !root.contains(target)) return false;
          target.scrollIntoView();
          return true;
        };
        if (!scrollToTarget()) {
          const fallback = root.querySelector("[data-hydrate-fallback]");
          if (fallback) {
            pendingFragment.current = key;
            observer = new MutationObserver(() => {
              if (scrollToTarget() || !root.contains(fallback)) {
                if (pendingFragment.current === key) pendingFragment.current = undefined;
                observer?.disconnect();
              }
            });
            observer.observe(root, { childList: true, subtree: true });
          }
        }
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
    return () => {
      observer?.disconnect();
      root.removeEventListener("scroll", record, true);
    };
  }, [location, navigationType]);

  return (
    <div ref={container} className="root-content" data-scroll-restoration-id="root">
      {children}
    </div>
  );
}
