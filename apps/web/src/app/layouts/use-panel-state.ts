import { useCallback, useEffect, useRef, useState } from "react";

/** Layout preference storage is intentionally left to the caller. */
export function usePanelState(
  value: boolean | undefined,
  defaultValue: boolean,
  onChange?: (open: boolean) => void,
  triggerId?: string,
) {
  const [internal, setInternal] = useState(defaultValue);
  const open = value ?? internal;
  const setOpen = useCallback(
    (next: boolean) => {
      if (value === undefined) setInternal(next);
      onChange?.(next);
      if (!next && triggerId) document.getElementById(triggerId)?.focus();
    },
    [value, onChange, triggerId],
  );
  return { open, setOpen };
}

/** Escape dismisses only the panel containing focus; body portals do not dismiss unrelated panels. */
export function usePanelEscape(open: boolean, close: (open: boolean) => void, panelId: string) {
  const previouslyOpen = useRef(open);
  useEffect(() => {
    if (open && !previouslyOpen.current) {
      document
        .getElementById(panelId)
        ?.querySelector<HTMLElement>("button,a[href],input,select,[tabindex='0']")
        ?.focus();
    }
    previouslyOpen.current = open;
  }, [open, panelId]);
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        event.target instanceof Node &&
        document.getElementById(panelId)?.contains(event.target)
      ) {
        event.stopPropagation();
        close(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close, panelId]);
}
